package ramlaal

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// EventSink receives events from a peer as they happen.
type EventSink func(ev map[string]any)

// RunResult is what a peer reports after one run.
type RunResult struct {
	OK      bool
	Summary string
	Error   string
	Usage   Usage
}

// Runner takes a prompt and a workspace and reports what happened. An empty model means the Codex default.
type Runner interface {
	Run(ctx context.Context, prompt, cwd, sandbox string, onEvent EventSink, model string) RunResult
}

// GatewayRunner runs one Codex turn through the Node gateway (codex app-server).
type GatewayRunner struct {
	base   string
	token  func() (string, error)
	client *http.Client
}

func NewGatewayRunner(baseURL string, token func() (string, error)) *GatewayRunner {
	return &GatewayRunner{base: strings.TrimRight(baseURL, "/"), token: token, client: &http.Client{Timeout: 30 * time.Minute, Transport: otelhttp.NewTransport(http.DefaultTransport)}}
}

func (g *GatewayRunner) Run(ctx context.Context, prompt, cwd, sandbox string, onEvent EventSink, model string) RunResult {
	body := map[string]any{"prompt": prompt, "cwd": cwd, "sandbox": sandbox}
	if model != "" {
		body["model"] = model
	}
	raw, _ := json.Marshal(body)
	var usage Usage
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.base+"/run", bytes.NewReader(raw))
	if err != nil {
		return RunResult{Error: err.Error(), Usage: usage}
	}
	req.Header.Set("Content-Type", "application/json")
	if err := bearer(req, g.token); err != nil {
		return RunResult{Error: fmt.Sprintf("gateway unreachable: %v", err), Usage: usage}
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return RunResult{Error: fmt.Sprintf("gateway unreachable: %v", err), Usage: usage}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return RunResult{Error: fmt.Sprintf("gateway unreachable: status %d", resp.StatusCode), Usage: usage}
	}

	parts := map[string]*strings.Builder{}
	var order []string
	status, errMsg := "failed", ""
	rd := bufio.NewReader(resp.Body)
	for {
		line, rerr := rd.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			var ev map[string]any
			if err := json.Unmarshal(line, &ev); err != nil {
				return RunResult{Error: fmt.Sprintf("gateway sent invalid event: %v", err), Usage: usage}
			}
			t, _ := ev["type"].(string)
			switch t {
			case "delta": // streamed to observers, not persisted
				id, _ := ev["itemId"].(string)
				text, _ := ev["text"].(string)
				if parts[id] == nil {
					parts[id] = &strings.Builder{}
					order = append(order, id)
				}
				parts[id].WriteString(text)
			case "usage": // cumulative per thread; the orchestrator records cost once
				usage = Usage{InputTokens: intOf(ev["inputTokens"]), CachedInputTokens: intOf(ev["cachedInputTokens"]), OutputTokens: intOf(ev["outputTokens"])}
			default:
				onEvent(ev)
				switch t {
				case "turn_completed":
					status = strOf(ev["status"])
					errMsg = strOf(ev["error"])
				case "error":
					errMsg = strOf(ev["message"])
				}
			}
		}
		if rerr != nil {
			if !errors.Is(rerr, io.EOF) {
				return RunResult{Error: fmt.Sprintf("gateway unreachable: %v", rerr), Usage: usage}
			}
			break
		}
	}
	summary := ""
	if len(order) > 0 {
		summary = parts[order[len(order)-1]].String()
	}
	if status == "completed" {
		return RunResult{OK: true, Summary: summary, Usage: usage}
	}
	if errMsg == "" {
		errMsg = status
	}
	return RunResult{Summary: summary, Error: errMsg, Usage: usage}
}

func intOf(v any) int {
	f, _ := v.(float64)
	return int(f)
}

func strOf(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

// Verifier is the objective gate: the task's own verification command.
type Verifier func(command, cwd string) (bool, string)

// RunVerify runs command through the platform shell in cwd, with a 10 minute limit.
func RunVerify(command, cwd string) (bool, string) {
	const timeout = 600 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", command)
	}
	cmd.Dir = cwd
	out, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return false, fmt.Sprintf("verify timed out after %ds", int(timeout.Seconds()))
	}
	return err == nil, tail(strings.TrimSpace(string(out)), 4000)
}

// tail keeps the last n characters.
func tail(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}

// head keeps the first n characters.
func head(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
