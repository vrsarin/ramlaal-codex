package ramlaal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// Memory is one recalled item.
type Memory struct {
	ID       string         `json:"id"`
	Text     string         `json:"text"`
	Score    float64        `json:"score"`
	Metadata map[string]any `json:"metadata"`
}

// MemoryClient is the long-term memory. Only verified outcomes are ever written.
type MemoryClient interface {
	Search(ctx context.Context, query string, limit int) ([]Memory, error)
	Add(ctx context.Context, text string, metadata map[string]any) (string, error)
}

// HttpMemory talks to the memory service.
type HttpMemory struct {
	base   string
	token  func() (string, error)
	client *http.Client
}

func NewHttpMemory(baseURL string, token func() (string, error)) *HttpMemory {
	return &HttpMemory{base: strings.TrimRight(baseURL, "/"), token: token, client: &http.Client{Timeout: 60 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)}}
}

func (m *HttpMemory) post(ctx context.Context, path string, body any, out any) error {
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.base+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if err := bearer(req, m.token); err != nil {
		return err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("memory %s: status %d: %s", path, resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (m *HttpMemory) Search(ctx context.Context, query string, limit int) ([]Memory, error) {
	var out struct {
		Results []Memory `json:"results"`
	}
	if err := m.post(ctx, "/search", map[string]any{"query": query, "limit": limit}, &out); err != nil {
		return nil, err
	}
	return out.Results, nil
}

func (m *HttpMemory) Add(ctx context.Context, text string, metadata map[string]any) (string, error) {
	if metadata == nil {
		metadata = map[string]any{}
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := m.post(ctx, "/add", map[string]any{"text": text, "metadata": metadata}, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

var tokenRe = regexp.MustCompile(`[a-z0-9_]{3,}`)

func tokens(s string) map[string]bool {
	set := map[string]bool{}
	for _, t := range tokenRe.FindAllString(strings.ToLower(s), -1) {
		set[t] = true
	}
	return set
}

// InMemoryMemory is a keyword-overlap stand-in for tests and the offline replay.
type InMemoryMemory struct {
	mu    sync.Mutex
	Items []Memory
}

func NewInMemoryMemory() *InMemoryMemory { return &InMemoryMemory{} }

func (m *InMemoryMemory) Search(ctx context.Context, query string, limit int) ([]Memory, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	q := tokens(query)
	denom := float64(len(q))
	if denom == 0 {
		denom = 1
	}
	scored := []Memory{}
	for _, it := range m.Items {
		overlap := 0
		for t := range tokens(it.Text) {
			if q[t] {
				overlap++
			}
		}
		if s := float64(overlap) / denom; s > 0 {
			scored = append(scored, Memory{ID: it.ID, Text: it.Text, Score: s, Metadata: it.Metadata})
		}
	}
	sort.SliceStable(scored, func(i, j int) bool { return scored[i].Score > scored[j].Score })
	if len(scored) > limit {
		scored = scored[:limit]
	}
	return scored, nil
}

func (m *InMemoryMemory) Add(ctx context.Context, text string, metadata map[string]any) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if metadata == nil {
		metadata = map[string]any{}
	}
	id := fmt.Sprintf("mem-%d", len(m.Items)+1)
	m.Items = append(m.Items, Memory{ID: id, Text: text, Metadata: metadata})
	return id, nil
}
