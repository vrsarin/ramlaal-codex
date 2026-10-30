package ramlaal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Decision is a typed multiple-choice answer with a confidence, so cheap models can steer the
// workflow. The workflow acts on confident answers and falls back to the safe, more expensive
// path otherwise.
type Decision struct {
	Choice       string
	Confidence   float64
	CostUSD      float64
	Source       string
	FallbackFrom string
}

// Decider answers small multiple-choice questions. Implementations are swappable: a free rule
// baseline, any OpenAI-compatible model through LiteLLM, or a dedicated decision model such as
// TypeSafe's Jev (implement Decider and register it in BuildDecider).
type Decider interface {
	Decide(ctx context.Context, name string, options []string, detail string) (Decision, error)
}

var (
	hardRe = regexp.MustCompile(`(?i)\b(refactor|migrat\w*|architecture|security|concurren\w*|race condition|distributed|performance|rewrite|multi[- ]?(file|module|service))\b`)
	envRe  = regexp.MustCompile(`(?i)(permission denied|unauthori[sz]ed|\b40[13]\b|api key|credential|gateway unreachable|connection refused|no space left)`)
	jsonRe = regexp.MustCompile(`(?s)\{.*\}`)
)

// RuleDecider is the free, deterministic baseline. It never proposes skipping review.
type RuleDecider struct{}

func (RuleDecider) Decide(ctx context.Context, name string, _ []string, detail string) (Decision, error) {
	switch name {
	case "route":
		if len([]rune(detail)) > 400 || hardRe.MatchString(detail) {
			return Decision{Choice: "strong", Confidence: 0.8, Source: "rules"}, nil
		}
		return Decision{Choice: "cheap", Confidence: 0.75, Source: "rules"}, nil
	case "after_failure":
		if envRe.MatchString(detail) {
			return Decision{Choice: "escalate", Confidence: 0.9, Source: "rules"}, nil // code cannot fix the environment
		}
		return Decision{Choice: "retry", Confidence: 0.8, Source: "rules"}, nil
	case "review":
		return Decision{Choice: "required", Confidence: 1.0, Source: "rules"}, nil
	}
	return Decision{}, fmt.Errorf("unknown decision: %s", name)
}

// LLMDecider calls any OpenAI-compatible chat endpoint and expects {"choice","confidence"} JSON.
type LLMDecider struct {
	url    string
	model  string
	apiKey string
	prices *PriceBook
	client *http.Client
}

func NewLLMDecider(baseURL, model, apiKey string, prices *PriceBook) *LLMDecider {
	return &LLMDecider{
		url:    strings.TrimRight(baseURL, "/") + "/chat/completions",
		model:  model,
		apiKey: apiKey,
		prices: prices,
		client: &http.Client{Timeout: 30 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)},
	}
}

func (d *LLMDecider) Decide(ctx context.Context, name string, options []string, detail string) (Decision, error) {
	if r := []rune(detail); len(r) > 3000 {
		detail = string(r[len(r)-3000:])
	}
	prompt := fmt.Sprintf("Decision: %s\nOptions: %s\n\nContext:\n%s\n\n"+
		`Answer with JSON only: {"choice": "<one option>", "confidence": <0..1>}. `+
		"Confidence is your honest probability that the choice is correct.",
		name, strings.Join(options, ", "), detail)
	body, _ := json.Marshal(map[string]any{
		"model":       d.model,
		"temperature": 0,
		"messages":    []map[string]string{{"role": "user", "content": prompt}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.url, bytes.NewReader(body))
	if err != nil {
		return Decision{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if d.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+d.apiKey)
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return Decision{}, fmt.Errorf("llm decider failed: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return Decision{}, fmt.Errorf("llm decider failed: %w", err)
	}
	if resp.StatusCode >= 400 {
		return Decision{}, fmt.Errorf("llm decider failed: status %d", resp.StatusCode)
	}
	var data struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &data); err != nil || len(data.Choices) == 0 {
		return Decision{}, errors.New("llm decider failed: malformed response")
	}
	m := jsonRe.FindString(data.Choices[0].Message.Content)
	if m == "" {
		return Decision{}, errors.New("llm decider failed: no JSON in answer")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(m), &parsed); err != nil {
		return Decision{}, fmt.Errorf("llm decider failed: %w", err)
	}
	choiceRaw, ok := parsed["choice"]
	if !ok {
		return Decision{}, errors.New("llm decider failed: missing choice")
	}
	conf, ok := toFloat(parsed["confidence"])
	if !ok {
		return Decision{}, errors.New("llm decider failed: missing confidence")
	}
	choice := strings.ToLower(strings.TrimSpace(fmt.Sprint(choiceRaw)))
	valid := false
	for _, o := range options {
		valid = valid || o == choice
	}
	if !valid {
		return Decision{}, fmt.Errorf("llm returned %q, expected one of %v", choice, options)
	}
	if conf < 0 {
		conf = 0
	} else if conf > 1 {
		conf = 1
	}
	usage := Usage{InputTokens: data.Usage.PromptTokens, OutputTokens: data.Usage.CompletionTokens}
	return Decision{Choice: choice, Confidence: conf, CostUSD: d.prices.Cost(d.model, usage), Source: "llm:" + d.model}, nil
}

func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	}
	return 0, false
}

// FallbackDecider tries each decider in order; the first that answers wins. The last should never fail.
type FallbackDecider struct {
	deciders []Decider
}

func NewFallbackDecider(d ...Decider) *FallbackDecider { return &FallbackDecider{deciders: d} }

func (f *FallbackDecider) Decide(ctx context.Context, name string, options []string, detail string) (Decision, error) {
	failed := ""
	for _, d := range f.deciders {
		dec, err := d.Decide(ctx, name, options, detail)
		if err != nil {
			if failed == "" {
				failed = typeName(d)
			}
			continue
		}
		dec.FallbackFrom = failed
		return dec, nil
	}
	return Decision{}, fmt.Errorf("no decider could answer %q", name)
}

func typeName(v any) string {
	t := reflect.TypeOf(v)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t.Name()
}

// BuildDecider selects a decider from env: DECIDER = rules | llm | jev.
func BuildDecider(env map[string]string, prices *PriceBook) (Decider, error) {
	get := func(k, def string) string {
		if v := env[k]; v != "" {
			return v
		}
		return def
	}
	switch kind := strings.ToLower(get("DECIDER", "rules")); kind {
	case "rules":
		return RuleDecider{}, nil
	case "llm":
		llm := NewLLMDecider(get("LLM_BASE_URL", "http://127.0.0.1:4000/v1"), get("DECIDER_MODEL", "codex-local"), env["LLM_API_KEY"], prices)
		return NewFallbackDecider(llm, RuleDecider{}), nil
	case "jev":
		return nil, errors.New("DECIDER=jev: implement a Jev adapter in decider.go once API access exists")
	default:
		return nil, fmt.Errorf("unknown DECIDER %q (rules | llm | jev)", kind)
	}
}

func osEnvMap() map[string]string {
	m := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	return m
}
