package ramlaal

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"ramlaal/orchestrator/auth"
)

func ptr[T any](v T) *T { return &v }

func kinds(l *Ledger, id int64) []string {
	out := []string{}
	for _, e := range l.Events(0, &id, 0) {
		out = append(out, e.Kind)
	}
	return out
}

func mustTask(t *testing.T, l *Ledger, id int64) Task {
	t.Helper()
	task, err := l.Task(id)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func sleepMs(n int) { time.Sleep(time.Duration(n) * time.Millisecond) }

func okVerify(string, string) (bool, string) { return true, "ok" }

// ---- loops ----

func TestHealsAfterFailedVerifyAndLearnsLesson(t *testing.T) {
	l, mem := NewMemoryLedger(), NewInMemoryMemory()
	id := l.CreateTask("fix the parser bug", ".", ptr("pytest"))
	worker := NewScriptedRunner(RunResult{OK: true, Summary: "patched"}, RunResult{OK: true, Summary: "patched properly"})
	checks := []struct {
		ok  bool
		out string
	}{{false, "boom"}, {true, "ok"}}
	i := 0
	verify := func(string, string) (bool, string) { c := checks[i]; i++; return c.ok, c.out }

	status := RunTask(context.Background(), id, l, worker, NewScriptedReviewer(Review{Approved: true}), mem, RunOptions{Verify: verify})

	if status != "completed" || mustTask(t, l, id).Attempts != 2 {
		t.Fatalf("status=%s attempts=%d", status, mustTask(t, l, id).Attempts)
	}
	if !strings.Contains(worker.Prompts[1], "boom") {
		t.Error("retry prompt should carry the failure")
	}
	if len(mem.Items) != 1 || mem.Items[0].Metadata["kind"] != "lesson" {
		t.Errorf("expected exactly one lesson, got %+v", mem.Items)
	}
}

func TestReviewerRejectionBlocksLearningAndEscalates(t *testing.T) {
	l, mem := NewMemoryLedger(), NewInMemoryMemory()
	id := l.CreateTask("fix it", ".", nil)
	worker := NewScriptedRunner(RunResult{OK: true, Summary: "done"}, RunResult{OK: true, Summary: "done"})
	rejects := NewScriptedReviewer(Review{Critique: "tests not added"}, Review{Critique: "tests not added"})

	if s := RunTask(context.Background(), id, l, worker, rejects, mem, RunOptions{MaxAttempts: 2}); s != "escalated" {
		t.Fatalf("status %s", s)
	}
	if len(mem.Items) != 0 {
		t.Error("rejected work must not be memorized")
	}
	if !contains(kinds(l, id), "escalated") {
		t.Error("missing escalated event")
	}
	if mustTask(t, l, id).Attempts != 2 {
		t.Errorf("attempts = %d", mustTask(t, l, id).Attempts)
	}
}

func TestAnswerSkipsReviewAndSharesOnlyRemembered(t *testing.T) {
	l := NewMemoryLedger()
	id := l.CreateTask("tell a joke, and I prefer dry humour", ".", nil)
	mem := NewInMemoryMemory()
	reply := "Why did the gopher cross the road?\nREMEMBER: User prefers dry humour in jokes\nKIND: answer"
	rejects := NewScriptedReviewer(Review{Critique: "must not be called"})
	worker := NewScriptedRunner(RunResult{OK: true, Summary: reply})
	opts := RunOptions{Identity: Identity{Instance: "i1", Purpose: "chat"}}
	if s := RunTask(context.Background(), id, l, worker, rejects, mem, opts); s != "completed" {
		t.Fatalf("status %s", s)
	}
	if len(mem.Items) != 1 || mem.Items[0].Text != "User prefers dry humour in jokes" {
		t.Fatalf("memory = %+v", mem.Items)
	}
	md := mem.Items[0].Metadata
	if md["instance"] != "i1" || md["purpose"] != "chat" || md["kind"] != "fact" {
		t.Errorf("metadata = %v", md)
	}
	if !strings.Contains(worker.Prompts[0], "REMEMBER:") {
		t.Error("prompt should explain the memory protocol")
	}
}

func TestAnswerSkipsConfiguredVerificationAndReview(t *testing.T) {
	l := NewMemoryLedger()
	v := "make test"
	id := l.CreateTask("tell me a joke", ".", &v)
	worker := NewScriptedRunner(RunResult{OK: true, Summary: "A joke.\nKIND: answer"})
	verifyCalled := false
	okVerify := func(string, string) (bool, string) {
		verifyCalled = true
		return true, "ok"
	}
	RunTask(context.Background(), id, l, worker, NewScriptedReviewer(), NewInMemoryMemory(), RunOptions{Verify: okVerify})
	if verifyCalled || len(payloads(l, id, "verify")) != 0 || len(payloads(l, id, "review")) != 0 {
		t.Error("a conversational answer must not run the configured work check or reviewer")
	}
	if mustTask(t, l, id).Status != "completed" {
		t.Error("a conversational answer should complete")
	}
}

type trackingMemory struct {
	searches int
	items    []Memory
}

func (m *trackingMemory) Search(_ context.Context, _ string, _ int) ([]Memory, error) {
	m.searches++
	return []Memory{{Text: "Use update_goal to solve the file size issue"}}, nil
}

func (m *trackingMemory) Add(_ context.Context, text string, metadata map[string]any) (string, error) {
	m.items = append(m.items, Memory{Text: text, Metadata: metadata})
	return "memory", nil
}

func TestJokeRequestRejectsToolCallAndDoesNotUseWorkMemory(t *testing.T) {
	l := NewMemoryLedger()
	id := l.CreateTask("tell a joke", ".", ptr("go test ./..."))
	mem := &trackingMemory{}
	worker := NewScriptedRunner(
		RunResult{OK: true, Summary: `{"name":"update_goal","arguments":{"objective":"solve the file size issue","token_budget":5000}}`},
		RunResult{OK: true, Summary: "Why did the scarecrow get promoted? It was outstanding in its field."},
	)
	reviewer := NewScriptedReviewer()
	verifyCalled := false
	verify := func(string, string) (bool, string) {
		verifyCalled = true
		return true, "ok"
	}

	status := RunTask(context.Background(), id, l, worker, reviewer, mem, RunOptions{MaxAttempts: 2, Verify: verify})
	if status != "completed" {
		t.Fatalf("status = %s", status)
	}
	if mem.searches != 0 || len(mem.items) != 0 {
		t.Errorf("conversation used or wrote work memory: searches=%d items=%+v", mem.searches, mem.items)
	}
	if verifyCalled || len(payloads(l, id, "verify")) != 0 || len(payloads(l, id, "review")) != 0 {
		t.Error("a joke request must not run work verification or review")
	}
	if len(worker.Prompts) != 2 || !strings.Contains(worker.Prompts[1], "tool-call metadata") {
		t.Errorf("expected a corrective retry prompt, got %q", worker.Prompts)
	}
	if worker.Sandboxes[0] != "read-only" || worker.Sandboxes[1] != "read-only" {
		t.Errorf("conversation sandboxes = %v", worker.Sandboxes)
	}
	if len(payloads(l, id, "attempt_failed")) != 1 || len(payloads(l, id, "memory_written")) != 0 {
		t.Error("invalid tool output must be retried, not learned")
	}
}

func TestParseReplyCapsAndStrips(t *testing.T) {
	r := ParseReply("hi\nREMEMBER: a\nREMEMBER: b\nREMEMBER: c\nREMEMBER: d\nREMEMBER: e\nREMEMBER: f\nKIND: work")
	if r.Answer || len(r.Remember) != 5 || r.Text != "hi" {
		t.Fatalf("%+v", r)
	}
}

func TestParseReplyDelegations(t *testing.T) {
	r := ParseReply("DELEGATE: Home | turn off the lights\nDELEGATE: netsec | scan the lan\nDELEGATE: a|1\nDELEGATE: b|2\nthinking")
	if len(r.Delegate) != 3 || r.Delegate[0] != (Delegation{"home", "turn off the lights"}) || r.Text != "thinking" {
		t.Fatalf("%+v", r)
	}
}

type fakeDelegator struct{ calls []string }

func (f *fakeDelegator) Peers() []Peer {
	return []Peer{{Instance: "home-1", Purpose: "appliances", Capabilities: []string{"home"}}}
}
func (f *fakeDelegator) Delegate(_ context.Context, c, req string) (string, error) {
	f.calls = append(f.calls, c+"|"+req)
	if c == "down" {
		return "", errors.New("peer unreachable")
	}
	return "ok from peer", nil
}

func TestDelegationRoundsAreBoundedAndFailuresReachWorker(t *testing.T) {
	l := NewMemoryLedger()
	id := l.CreateTask("do it", ".", nil)
	d := &fakeDelegator{}
	// a worker that never stops delegating must be cut off after maxDelegateRound rounds
	loop := RunResult{OK: true, Summary: "DELEGATE: down | again"}
	worker := NewScriptedRunner(loop, loop, loop, RunResult{OK: true, Summary: "gave up\nKIND: answer"})
	RunTask(context.Background(), id, l, worker, NewScriptedReviewer(Review{Approved: true}), NewInMemoryMemory(), RunOptions{Delegator: d})
	if len(d.calls) != maxDelegateRound {
		t.Fatalf("delegations = %v", d.calls)
	}
	if !strings.Contains(worker.Prompts[1], "peer unreachable") {
		t.Error("the delegation failure should be shown to the worker")
	}
}

func TestAgentFailureIsRetried(t *testing.T) {
	l := NewMemoryLedger()
	id := l.CreateTask("do work", ".", nil)
	worker := NewScriptedRunner(RunResult{Error: "timeout"}, RunResult{OK: true, Summary: "ok"})
	if s := RunTask(context.Background(), id, l, worker, NewScriptedReviewer(Review{Approved: true}), NewInMemoryMemory(), RunOptions{}); s != "completed" {
		t.Fatalf("status %s", s)
	}
	if !strings.Contains(worker.Prompts[1], "timeout") {
		t.Error("retry prompt should carry the timeout")
	}
}

func TestSecondTaskReusesVerifiedLesson(t *testing.T) {
	l := NewMemoryLedger()
	ids := RunDemo(l, nil)
	retrieved := payloads(l, ids[1], "memory_retrieved")[0]
	if len(retrieved["ids"].([]any)) == 0 {
		t.Error("second task should retrieve the lesson")
	}
	if mustTask(t, l, ids[0]).Attempts != 2 || mustTask(t, l, ids[1]).Attempts != 1 {
		t.Error("expected 2 attempts then 1")
	}
}

func TestDemoHasNoMemoryErrors(t *testing.T) {
	l := NewMemoryLedger()
	RunDemo(l, nil)
	for _, e := range l.Events(0, nil, 0) {
		if e.Kind == "memory_error" {
			t.Fatal("unexpected memory_error")
		}
	}
}

type failingMemory struct{ MemoryClient }

func (failingMemory) Search(_ context.Context, _ string, _ int) ([]Memory, error) { return nil, errors.New("down") }

func TestMemoryOutageDoesNotBlockTask(t *testing.T) {
	l := NewMemoryLedger()
	id := l.CreateTask("x", ".", nil)
	s := RunTask(context.Background(), id, l, NewScriptedRunner(RunResult{OK: true, Summary: "ok"}), NewScriptedReviewer(Review{Approved: true}), failingMemory{NewInMemoryMemory()}, RunOptions{})
	if s != "completed" || len(payloads(l, id, "memory_error")) != 1 {
		t.Fatalf("status=%s", s)
	}
}

func TestReviewerVerdictParsing(t *testing.T) {
	cases := []struct {
		reply    string
		approved bool
		critique string
	}{
		{"fine\nVERDICT: APPROVE", true, "approved"},
		{"VERDICT: REJECT - no tests", false, "no tests"},
		{"no verdict here", false, "reviewer gave no explicit verdict"},
	}
	for _, c := range cases {
		r := NewCodexReviewer(NewScriptedRunner(RunResult{OK: true, Summary: c.reply}), "")
		got := r.Review(context.Background(), "m", ".", RunResult{}, "", func(map[string]any) {})
		if got.Approved != c.approved || got.Critique != c.critique {
			t.Errorf("%q -> %+v", c.reply, got)
		}
	}
}

// ---- cost / policy ----

type fixed map[string]any

func (f fixed) Decide(_ context.Context, name string, _ []string, _ string) (Decision, error) {
	switch a := f[name].(type) {
	case error:
		return Decision{}, a
	case [2]any:
		return Decision{Choice: a[0].(string), Confidence: a[1].(float64), Source: "fixed"}, nil
	}
	return Decision{}, errors.New("no answer")
}

func TestPriceBookDiscountsCachedInput(t *testing.T) {
	cached := 0.5
	pb := NewPriceBook(map[string]ModelPrice{"m": {Input: 2, CachedInput: &cached, Output: 10}})
	if got := pb.Cost("m", Usage{1_000_000, 400_000, 100_000}); !approx(got, 0.6*2+0.4*0.5+1.0) {
		t.Errorf("cost %v", got)
	}
	if pb.Cost("unknown", Usage{10, 0, 10}) != 0 {
		t.Error("unknown models are free")
	}
}

func TestDemoStartsCheapEscalatesTierOnFailureAndTracksCost(t *testing.T) {
	l := NewMemoryLedger()
	ids := RunDemo(l, nil)
	a := payloads(l, ids[0], "attempt_started")
	if len(a) != 2 || a[0]["tier"] != "cheap" || a[0]["model"] != "small-model" || a[1]["tier"] != "strong" || a[1]["model"] != "big-model" {
		t.Fatalf("attempts %+v", a)
	}
	if b := payloads(l, ids[1], "attempt_started"); len(b) != 1 || b[0]["tier"] != "cheap" {
		t.Fatalf("second task %+v", b)
	}
	c1, c2 := mustTask(t, l, ids[0]).CostUSD, mustTask(t, l, ids[1]).CostUSD
	if !(c1 > c2 && c2 > 0) {
		t.Errorf("costs %v %v", c1, c2)
	}
	sum := 0.0
	for _, p := range payloads(l, ids[0], "cost") {
		sum += p["cost_usd"].(float64)
	}
	if !approx(c1, sum) {
		t.Errorf("ledger cost %v != event sum %v", c1, sum)
	}
}

func TestHardMissionRoutesToStrongImmediately(t *testing.T) {
	l := NewMemoryLedger()
	w := NewScriptedRunner(RunResult{OK: true, Summary: "ok"})
	id := l.CreateTask("Refactor the authentication module across services", ".", nil)
	RunTask(context.Background(), id, l, w, NewScriptedReviewer(Review{Approved: true}), NewInMemoryMemory(), RunOptions{Policy: DemoPolicy()})
	if len(w.Models) != 1 || w.Models[0] != "big-model" {
		t.Fatalf("models %v", w.Models)
	}
}

func TestUnsureOrBrokenDeciderTakesSafeStrongPath(t *testing.T) {
	for name, answer := range map[string]any{"unsure": [2]any{"cheap", 0.4}, "broken": errors.New("down")} {
		l := NewMemoryLedger()
		w := NewScriptedRunner(RunResult{OK: true, Summary: "ok"})
		id := l.CreateTask("rename a variable", ".", nil)
		p := NewPolicy()
		p.Decider, p.CheapModel, p.StrongModel = fixed{"route": answer}, "c", "s"
		RunTask(context.Background(), id, l, w, NewScriptedReviewer(Review{Approved: true}), NewInMemoryMemory(), RunOptions{Policy: p})
		if w.Models[0] != "s" {
			t.Errorf("%s: models %v", name, w.Models)
		}
	}
}

func TestUnfixableFailureEscalatesEarly(t *testing.T) {
	l := NewMemoryLedger()
	id := l.CreateTask("deploy it", ".", nil)
	bad := RunResult{Error: "401 Unauthorized: bad api key"}
	s := RunTask(context.Background(), id, l, NewScriptedRunner(bad, bad, bad), NewScriptedReviewer(), NewInMemoryMemory(), RunOptions{MaxAttempts: 3})
	if s != "escalated" || mustTask(t, l, id).Attempts != 1 {
		t.Fatalf("status=%s attempts=%d", s, mustTask(t, l, id).Attempts)
	}
	if payloads(l, id, "escalated")[0]["reason"] != "a retry cannot fix this" {
		t.Error("wrong escalation reason")
	}
}

func TestLowConfidenceEscalationStillRetries(t *testing.T) {
	l := NewMemoryLedger()
	id := l.CreateTask("x", ".", nil)
	p := NewPolicy()
	p.Decider = fixed{"route": [2]any{"cheap", 0.9}, "after_failure": [2]any{"escalate", 0.5}}
	w := NewScriptedRunner(RunResult{Error: "nope"}, RunResult{OK: true, Summary: "ok"})
	if s := RunTask(context.Background(), id, l, w, NewScriptedReviewer(Review{Approved: true}), NewInMemoryMemory(), RunOptions{Policy: p}); s != "completed" {
		t.Fatalf("status %s", s)
	}
}

func TestReviewNeverSkippedByDefault(t *testing.T) {
	l := NewMemoryLedger()
	id := l.CreateTask("x", ".", ptr("pytest"))
	RunTask(context.Background(), id, l, NewScriptedRunner(RunResult{OK: true, Summary: "ok"}), NewScriptedReviewer(Review{Approved: true}), NewInMemoryMemory(), RunOptions{Verify: okVerify})
	if len(payloads(l, id, "review")) == 0 || len(payloads(l, id, "review_skipped")) != 0 {
		t.Error("review must run")
	}
}

func TestConfidentSkipCompletesButDoesNotMemorize(t *testing.T) {
	l, mem := NewMemoryLedger(), NewInMemoryMemory()
	id := l.CreateTask("x", ".", ptr("pytest"))
	p := NewPolicy()
	p.Decider, p.SkipReviewConfidence = fixed{"route": [2]any{"cheap", 0.9}, "review": [2]any{"skip", 0.95}}, ptr(0.9)
	s := RunTask(context.Background(), id, l, NewScriptedRunner(RunResult{OK: true, Summary: "ok"}), NewScriptedReviewer(), mem, RunOptions{Verify: okVerify, Policy: p})
	if s != "completed" || len(payloads(l, id, "review_skipped")) == 0 || len(payloads(l, id, "review")) != 0 || len(mem.Items) != 0 {
		t.Fatalf("status=%s mem=%v", s, mem.Items)
	}
}

func TestSkipRequiresObjectiveCheck(t *testing.T) {
	l := NewMemoryLedger()
	id := l.CreateTask("x", ".", nil)
	p := NewPolicy()
	p.Decider, p.SkipReviewConfidence = fixed{"route": [2]any{"cheap", 0.9}, "review": [2]any{"skip", 1.0}}, ptr(0.5)
	RunTask(context.Background(), id, l, NewScriptedRunner(RunResult{OK: true, Summary: "ok"}), NewScriptedReviewer(Review{Approved: true}), NewInMemoryMemory(), RunOptions{Policy: p})
	if len(payloads(l, id, "review")) == 0 || len(payloads(l, id, "review_skipped")) != 0 {
		t.Error("no verify command means no skipping")
	}
}

func finished(l *Ledger, p *Policy, tier string, ok bool) {
	id := l.CreateTask("x", ".", nil)
	status, attempts := "escalated", 3
	if ok {
		status, attempts = "completed", 1
	}
	p.RecordOutcome(l, id, tier, status, attempts)
}

func TestCheapTierDroppedWhenFailingThenReprobed(t *testing.T) {
	l := NewMemoryLedger()
	p := NewPolicy()
	p.Decider, p.TuneMinSamples, p.ProbeEvery = fixed{"route": [2]any{"cheap", 0.95}}, 5, 3
	for i := 0; i < 5; i++ {
		finished(l, p, "cheap", false)
	}
	id := l.CreateTask("x", ".", nil)
	if p.Route(context.Background(), l, id, "x") != "strong" || len(payloads(l, id, "route_overridden")) == 0 {
		t.Fatal("cheap tier should be overridden")
	}
	for i := 0; i < 3; i++ { // strong runs in between, then a probe is allowed
		finished(l, p, "strong", true)
	}
	if p.Route(context.Background(), l, l.CreateTask("x", ".", nil), "x") != "cheap" {
		t.Fatal("cheap tier should be re-probed")
	}
}

func TestCheapTierKeptWhenItWorks(t *testing.T) {
	l := NewMemoryLedger()
	p := NewPolicy()
	p.Decider, p.TuneMinSamples = fixed{"route": [2]any{"cheap", 0.95}}, 5
	for _, ok := range []bool{true, true, true, false, true} {
		finished(l, p, "cheap", ok)
	}
	if p.Route(context.Background(), l, l.CreateTask("x", ".", nil), "x") != "cheap" {
		t.Fatal("cheap tier should be kept")
	}
}

// ---- deciders ----

func TestRuleDeciderAndFallbackChain(t *testing.T) {
	r := RuleDecider{}
	opts := []string{"cheap", "strong"}
	if d, _ := r.Decide(context.Background(), "route", opts, "fix typo"); d.Choice != "cheap" {
		t.Error("typo should be cheap")
	}
	if d, _ := r.Decide(context.Background(), "route", opts, "migrate the database layer"); d.Choice != "strong" {
		t.Error("migration should be strong")
	}
	if d, _ := r.Decide(context.Background(), "review", nil, ""); d.Choice != "required" {
		t.Error("review is always required")
	}
	if _, err := r.Decide(context.Background(), "bogus", nil, ""); err == nil {
		t.Error("unknown decision should error")
	}
	d, err := NewFallbackDecider(fixed{"route": errors.New("x")}, RuleDecider{}).Decide(context.Background(), "route", opts, "fix typo")
	if err != nil || d.Choice != "cheap" || d.FallbackFrom != "fixed" {
		t.Errorf("%+v %v", d, err)
	}
}

func llmServer(t *testing.T, content string, usage map[string]int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": content}}},
			"usage":   usage,
		})
	}))
}

func TestLLMDeciderParsesTypedAnswerAndPricesIt(t *testing.T) {
	srv := llmServer(t, `Sure: {"choice": "Retry", "confidence": 1.4}`, map[string]int{"prompt_tokens": 1000, "completion_tokens": 20})
	defer srv.Close()
	d := NewLLMDecider(srv.URL+"/v1", "tiny", "", NewPriceBook(map[string]ModelPrice{"tiny": {Input: 1, Output: 1}}))
	out, err := d.Decide(context.Background(), "after_failure", []string{"retry", "escalate"}, "ctx")
	if err != nil || out.Choice != "retry" || out.Confidence != 1.0 || !approx(out.CostUSD, 0.00102) {
		t.Fatalf("%+v %v", out, err)
	}
}

func TestLLMDeciderRejectsBadAnswers(t *testing.T) {
	for _, content := range []string{"no json here", `{"choice": "maybe", "confidence": 0.9}`, `{"choice": "retry"}`} {
		srv := llmServer(t, content, nil)
		_, err := NewLLMDecider(srv.URL+"/v1", "tiny", "", nil).Decide(context.Background(), "after_failure", []string{"retry", "escalate"}, "ctx")
		srv.Close()
		if err == nil {
			t.Errorf("%q should be rejected", content)
		}
	}
}

func TestBuildDeciderSelection(t *testing.T) {
	if d, err := BuildDecider(map[string]string{}, nil); err != nil || typeName(d) != "RuleDecider" {
		t.Errorf("default: %v %v", d, err)
	}
	if d, err := BuildDecider(map[string]string{"DECIDER": "llm"}, nil); err != nil || typeName(d) != "FallbackDecider" {
		t.Errorf("llm: %v %v", d, err)
	}
	if _, err := BuildDecider(map[string]string{"DECIDER": "jev"}, nil); err == nil {
		t.Error("jev should fail fast")
	}
	if _, err := BuildDecider(map[string]string{"DECIDER": "bogus"}, nil); err == nil {
		t.Error("bogus should fail")
	}
}

func TestPolicyFromEnv(t *testing.T) {
	p, err := PolicyFromEnv(map[string]string{
		"MODEL_CHEAP": "c", "MODEL_STRONG": "s", "SKIP_REVIEW_CONFIDENCE": "0.9",
		"MODEL_PRICES": `{"c":{"input":1,"cached_input":0.1,"output":2}}`,
	})
	if err != nil || p.CheapModel != "c" || p.ReviewModel() != "s" || p.SkipReviewConfidence == nil || *p.SkipReviewConfidence != 0.9 {
		t.Fatalf("%+v %v", p, err)
	}
	if p.Prices.Cost("c", Usage{InputTokens: 1_000_000}) != 1 {
		t.Error("prices not loaded")
	}
	if _, err := PolicyFromEnv(map[string]string{"MODEL_PRICES": "{"}); err == nil {
		t.Error("bad MODEL_PRICES should error")
	}
}

// ---- ledger ----

func TestLedgerKeepsOnlyRecentEntriesAndIsolatesUsers(t *testing.T) {
	ls := NewLedgers()
	alice, bob := ls.For("alice"), ls.For("bob")
	if ls.For("alice") != alice {
		t.Fatal("a user must get the same ledger every time")
	}
	id := alice.CreateTask("m", ".", nil)
	alice.AddCost(id, 0.25)
	if mustTask(t, alice, id).CostUSD != 0.25 {
		t.Error("cost not recorded")
	}
	if len(bob.Tasks()) != 0 {
		t.Error("bob must not see alice's tasks")
	}
	for i := 0; i < maxEvents+10; i++ {
		alice.Append("x", &id, "", nil)
	}
	for i := 0; i < maxTasks+10; i++ {
		alice.CreateTask("m", ".", nil)
	}
	if n := len(alice.Events(0, nil, maxEvents*2)); n != maxEvents {
		t.Errorf("events kept = %d", n)
	}
	if n := len(alice.Tasks()); n != maxTasks {
		t.Errorf("tasks kept = %d", n)
	}
	if _, err := alice.Task(id); err == nil {
		t.Error("the oldest task should have been dropped")
	}
}

// ---- server ----

func TestReplayPopulatesLedgerAndAPI(t *testing.T) {
	s := &Server{Ledgers: NewLedgers(), Policy: NewPolicy()}
	h := s.Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/replay", nil))
	var rep struct{ IDs []int64 }
	_ = json.Unmarshal(rec.Body.Bytes(), &rep)
	if len(rep.IDs) != 2 {
		t.Fatalf("replay: %s", rec.Body)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/events?task_id="+itoa(rep.IDs[0]), nil))
	var evs []Event
	_ = json.Unmarshal(rec.Body.Bytes(), &evs)
	have := map[string]bool{}
	for _, e := range evs {
		have[e.Kind] = true
	}
	for _, k := range []string{"attempt_failed", "memory_written", "task_completed"} {
		if !have[k] {
			t.Errorf("missing %s", k)
		}
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/tasks", nil))
	var tasks []Task
	_ = json.Unmarshal(rec.Body.Bytes(), &tasks)
	if len(tasks) < 2 || tasks[0].Status != "completed" || tasks[1].Status != "completed" {
		t.Fatalf("tasks: %s", rec.Body)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/stats", nil))
	var st struct {
		Tasks  int
		ByTier map[string]struct{ Tasks, FirstTryOK int } `json:"by_tier"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &st)
	if st.Tasks != 2 || st.ByTier["cheap"].Tasks != 2 {
		t.Fatalf("stats: %s", rec.Body)
	}
}

func TestCreateTaskRunsInBackgroundAndValidates(t *testing.T) {
	ls := NewLedgers()
	l := ls.For(auth.DevUser)
	runner := NewScriptedRunner(RunResult{OK: true, Summary: "hi\nVERDICT: APPROVE"}, RunResult{OK: true, Summary: "VERDICT: APPROVE"})
	s := &Server{
		Ledgers: ls, Policy: NewPolicy(), MaxAttempts: 2, DefaultWorkspace: "/ws",
		NewRunner: func() Runner { return runner },
		NewMemory: func() MemoryClient { return NewInMemoryMemory() },
	}
	h := s.Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/tasks", strings.NewReader(`{}`)))
	if rec.Code != 422 {
		t.Fatalf("empty mission -> %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/tasks", strings.NewReader(`{"mission":"say hi"}`)))
	if rec.Code != 200 {
		t.Fatalf("create -> %d %s", rec.Code, rec.Body)
	}
	var out struct{ ID int64 }
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if mustTask(t, l, out.ID).Workspace != "/ws" {
		t.Error("default workspace not applied")
	}
	deadline := 0
	for mustTask(t, l, out.ID).Status != "completed" {
		deadline++
		if deadline > 200 {
			t.Fatalf("task never completed: %s", mustTask(t, l, out.ID).Status)
		}
		sleepMs(25)
	}
}
