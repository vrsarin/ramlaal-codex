package ramlaal

import (
	"context"
	"sync"
)

// ScriptedRunner replays canned results, for the offline demo and tests.
type ScriptedRunner struct {
	mu        sync.Mutex
	results   []RunResult
	Prompts   []string
	Models    []string
	Sandboxes []string
}

func NewScriptedRunner(results ...RunResult) *ScriptedRunner {
	return &ScriptedRunner{results: results}
}

func (s *ScriptedRunner) Run(_ context.Context, prompt, cwd, sandbox string, onEvent EventSink, model string) RunResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Prompts = append(s.Prompts, prompt)
	s.Models = append(s.Models, model)
	s.Sandboxes = append(s.Sandboxes, sandbox)
	r := s.results[0]
	s.results = s.results[1:]
	onEvent(map[string]any{"type": "item", "item": map[string]any{"type": "agentMessage", "text": r.Summary}})
	return r
}

// ScriptedReviewer replays canned verdicts.
type ScriptedReviewer struct {
	mu       sync.Mutex
	verdicts []Review
}

func NewScriptedReviewer(verdicts ...Review) *ScriptedReviewer {
	return &ScriptedReviewer{verdicts: verdicts}
}

func (s *ScriptedReviewer) ModelName() string { return "" }

func (s *ScriptedReviewer) Review(_ context.Context, _, _ string, _ RunResult, _ string, _ EventSink) Review {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.verdicts[0]
	s.verdicts = s.verdicts[1:]
	return v
}

// DemoPolicy prices a small and a big model so the demo shows real cost differences.
func DemoPolicy() *Policy {
	p := NewPolicy()
	p.Prices = NewPriceBook(map[string]ModelPrice{
		"small-model": {Input: 0.1, Output: 0.4},
		"big-model":   {Input: 3.0, Output: 12.0},
	})
	p.CheapModel, p.StrongModel = "small-model", "big-model"
	return p
}

// RunDemo runs two similar tasks: the first heals (cheap model, then the strong one) and learns;
// the second reuses the lesson and succeeds on the cheap model. No model calls.
func RunDemo(l *Ledger, memory MemoryClient) []int64 {
	if memory == nil {
		memory = NewInMemoryMemory()
	}
	policy := DemoPolicy()
	checks := []struct {
		ok  bool
		out string
	}{{false, "AssertionError: expected 3 got 2"}, {true, "1 passed"}}
	i := 0
	verify := func(string, string) (bool, string) {
		c := checks[i]
		i++
		return c.ok, c.out
	}
	work := Usage{InputTokens: 4000, OutputTokens: 800}
	cmd := "pytest -q"

	t1 := l.CreateTask("Fix off-by-one error in the pagination helper and make the unit tests pass", ".", &cmd)
	RunTask(context.Background(), t1, l,
		NewScriptedRunner(
			RunResult{OK: true, Summary: "Changed range(n) to range(n)", Usage: work},
			RunResult{OK: true, Summary: "Changed range(n) to range(n + 1) in paginate()", Usage: work}),
		NewScriptedReviewer(Review{Approved: true, Critique: "ok", Usage: Usage{InputTokens: 1500, OutputTokens: 100}}),
		memory, RunOptions{Verify: verify, Policy: policy})

	t2 := l.CreateTask("Pagination helper has an off-by-one error; fix it", ".", nil)
	RunTask(context.Background(), t2, l,
		NewScriptedRunner(RunResult{OK: true, Summary: "Applied the range(n + 1) fix directly", Usage: work}),
		NewScriptedReviewer(Review{Approved: true, Critique: "ok", Usage: Usage{InputTokens: 1200, OutputTokens: 80}}),
		memory, RunOptions{Policy: policy})
	return []int64{t1, t2}
}
