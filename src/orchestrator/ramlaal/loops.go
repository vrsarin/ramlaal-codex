// Package ramlaal is the self-healing, self-learning loop around Codex.
//
// Heal: a failed attempt (agent error, failed verify, or reviewer rejection) is recorded, and
// the critique and previously verified lessons are fed into a bounded retry.
// Learn: only an outcome that passed verification AND independent review is promoted to
// long-term memory; failures stay in the ledger as audit records.
package ramlaal

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"ramlaal/orchestrator/auth"
)

// Review is a reviewer's verdict.
type Review struct {
	Approved bool
	Critique string
	Usage    Usage
}

// Reviewer is an independent peer that must emit an explicit verdict.
type Reviewer interface {
	Review(ctx context.Context, mission, cwd string, result RunResult, verifyOutput string, onEvent EventSink) Review
	// ModelName is the model the reviewer runs on; empty means the default.
	ModelName() string
}

// CodexReviewer is a read-only Codex session.
type CodexReviewer struct {
	runner Runner
	model  string
}

func NewCodexReviewer(r Runner, model string) *CodexReviewer {
	return &CodexReviewer{runner: r, model: model}
}

func (c *CodexReviewer) ModelName() string { return c.model }

var verdictRe = regexp.MustCompile(`VERDICT:\s*(APPROVE|REJECT)\b(.*)`)

func (c *CodexReviewer) Review(ctx context.Context, mission, cwd string, result RunResult, verifyOutput string, onEvent EventSink) Review {
	if verifyOutput == "" {
		verifyOutput = "(none)"
	}
	prompt := "You are an independent reviewer. Do not modify files.\n" +
		"The mission below IS the user's request; do not require the user to ask again or to confirm it.\n" +
		fmt.Sprintf("Mission:\n%s\n\nWorker's final reply:\n%s\n\nVerification output:\n%s\n\n", mission, result.Summary, verifyOutput) +
		"Decide whether the worker's reply and any file changes satisfy the mission. " +
		"If the mission is a question or conversational request that needs no file changes (for example a joke, " +
		"an explanation or an answer), judge the reply itself and do not reject for lack of file changes. " +
		"Only inspect the workspace when the mission involves code or files. " +
		"End with exactly one line: 'VERDICT: APPROVE' or 'VERDICT: REJECT - <reason>'."
	r := c.runner.Run(ctx, prompt, cwd, "read-only", onEvent, c.model)
	m := verdictRe.FindAllStringSubmatch(r.Summary, -1)
	if !r.OK || len(m) == 0 {
		critique := r.Error
		if critique == "" {
			critique = "reviewer gave no explicit verdict"
		}
		return Review{Critique: critique, Usage: r.Usage}
	}
	last := m[len(m)-1]
	critique := strings.Trim(last[2], " -:")
	if critique == "" {
		critique = "approved"
	}
	return Review{Approved: last[1] == "APPROVE", Critique: critique, Usage: r.Usage}
}

// BuildPrompt assembles the worker prompt: mission, recalled lessons, and the previous failure.
func BuildPrompt(mission string, memories []Memory, previousProblem string) string {
	parts := []string{mission}
	if len(memories) > 0 {
		parts = append(parts, "Shared memory from earlier work, possibly by other Ramlaal instances (use if relevant, do not trust blindly):")
		for _, m := range memories {
			line := "- " + m.Text
			if p, _ := m.Metadata["purpose"].(string); p != "" {
				line = "- [" + p + "] " + m.Text
			}
			parts = append(parts, line)
		}
	}
	if previousProblem != "" {
		parts = append(parts, "Your previous attempt did not pass. Fix the cause, not the symptom:", "- Problem: "+previousProblem)
	}
	return strings.Join(parts, "\n\n")
}

// RunOptions tunes RunTask; zero values mean defaults (3 attempts, RunVerify, default Policy).
type RunOptions struct {
	MaxAttempts int
	Verify      Verifier
	Policy      *Policy
	Identity    Identity
	Delegator   Delegator // nil for a standalone instance, or when serving a delegated request
	User        string    // the user the task runs for; peers are told, so they act for the same user
}

// RunTask runs one task through heal/learn and returns its final status ("completed" or "escalated").
func RunTask(ctx context.Context, taskID int64, l *Ledger, worker Runner, reviewer Reviewer, memory MemoryClient, opts RunOptions) string {
	ctx, taskSpan := otel.Tracer("ramlaal").Start(ctx, "ramlaal.task", trace.WithAttributes(
		attribute.Int64("ramlaal.task_id", taskID), attribute.String("ramlaal.instance", opts.Identity.Instance)))
	defer taskSpan.End()
	if opts.MaxAttempts <= 0 {
		opts.MaxAttempts = 3
	}
	if opts.Verify == nil {
		opts.Verify = RunVerify
	}
	policy := opts.Policy
	if policy == nil {
		policy = NewPolicy()
	}
	task, err := l.Task(taskID)
	if err != nil {
		panic(err)
	}
	mission, cwd := task.Mission, task.Workspace
	conversational := isConversationalMission(mission)
	const peer = "worker"
	emit := func(who string) EventSink {
		return func(ev map[string]any) { l.Append("codex", &taskID, who, ev) }
	}

	var used []Memory
	if !conversational {
		used, err = memory.Search(ctx, mission, 5)
		if err != nil { // a memory outage must not block the task
			used = nil
			l.Append("memory_error", &taskID, "memory", map[string]any{"op": "search", "error": err.Error()})
		}
	}
	ids, texts := []string{}, []string{}
	for _, m := range used {
		ids, texts = append(ids, m.ID), append(texts, m.Text)
	}
	l.Append("memory_retrieved", &taskID, "memory", map[string]any{"ids": ids, "texts": texts})
	running := "running"
	l.UpdateTask(taskID, &running, nil)

	tier := policy.Route(ctx, l, taskID, mission)
	var peers []Peer
	if opts.Delegator != nil {
		peers = opts.Delegator.Peers()
	}
	promptMission := mission
	sandbox := "workspace-write"
	if conversational {
		sandbox = "read-only"
		promptMission = "This is a conversational request. Answer directly; do not use tools, inspect the workspace, or modify files.\n\n" + mission
	}
	ctx = auth.WithUser(ctx, opts.User)
	lastReply := ""
	previousProblem := ""
	failures := []string{}
	status, reason := "escalated", "max attempts exhausted"
	attempt := 0
	for attempt = 1; attempt <= opts.MaxAttempts; attempt++ {
		// start on the routed tier; a failed attempt means the cheap tier was not enough
		useTier := tier
		if attempt > 1 {
			useTier = "strong"
		}
		model := policy.ModelFor(useTier)
		n := attempt
		l.UpdateTask(taskID, nil, &n)
		l.Append("attempt_started", &taskID, peer, map[string]any{"attempt": attempt, "tier": useTier, "model": nilIfEmpty(model)})
		attemptCtx, attemptSpan := otel.Tracer("ramlaal").Start(ctx, "ramlaal.attempt", trace.WithAttributes(
			attribute.Int("ramlaal.attempt", attempt), attribute.String("ramlaal.tier", useTier), attribute.String("gen_ai.request.model", model)))
		slog.InfoContext(attemptCtx, "attempt started", "task_id", taskID, "attempt", attempt, "tier", useTier, "model", model)
		prompt := BuildPrompt(promptMission, used, previousProblem)
		result := worker.Run(attemptCtx, AssistantPreamble(opts.Identity, peers)+"\n\n"+prompt, cwd, sandbox, emit(peer), model)
		policy.Charge(l, taskID, peer, model, result.Usage)
		reply := ParseReply(result.Summary)
		for round := 0; !conversational && round < maxDelegateRound && result.OK && len(reply.Delegate) > 0 && opts.Delegator != nil; round++ {
			prompt += "\n\n" + runDelegations(ctx, taskID, l, opts.Delegator, reply.Delegate)
			result = worker.Run(attemptCtx, AssistantPreamble(opts.Identity, peers)+"\n\n"+prompt, cwd, sandbox, emit(peer), model)
			policy.Charge(l, taskID, peer, model, result.Usage)
			reply = ParseReply(result.Summary)
		}
		result.Summary = reply.Text
		lastReply = reply.Text

		answerRequest := reply.Answer || conversational
		responseProblem := ""
		if conversational {
			switch {
			case strings.TrimSpace(reply.Text) == "":
				responseProblem = "no conversational answer was returned"
			case isToolCallOutput(reply.Text):
				responseProblem = "the model returned tool-call metadata instead of answering the conversational request"
			}
		}
		verifyOut, verified := "", true
		hasVerify := task.VerifyCommand != nil && *task.VerifyCommand != ""
		if result.OK && hasVerify && !answerRequest {
			verified, verifyOut = opts.Verify(*task.VerifyCommand, cwd)
			l.Append("verify", &taskID, "verifier", map[string]any{"ok": verified, "output": verifyOut})
		}

		problem := ""
		switch {
		case !result.OK:
			problem = result.Error
			if problem == "" {
				problem = "agent run failed"
			}
		case responseProblem != "":
			problem = responseProblem
		case !verified:
			problem = "verification failed: " + tail(verifyOut, 800)
		case answerRequest:
			// a plain answer has nothing to verify or review; only facts the assistant chose to share are kept
			l.Append("answered", &taskID, "policy", map[string]any{"reason": "no file changes or commands needed"})
			shareMemories(ctx, taskID, l, memory, opts.Identity, reply.Remember)
			status = "completed"
		case hasVerify && policy.CanSkipReview(ctx, l, taskID, mission, verifyOut):
			// confident and objectively verified: complete, but unreviewed work is never memorized
			l.Append("review_skipped", &taskID, "policy", map[string]any{"reason": "verified and decider confident"})
			status = "completed"
		default:
			rv := reviewer.Review(attemptCtx, mission, cwd, result, verifyOut, emit("reviewer"))
			rm := reviewer.ModelName()
			if rm == "" {
				rm = policy.ReviewModel()
			}
			policy.Charge(l, taskID, "reviewer", rm, rv.Usage)
			l.Append("review", &taskID, "reviewer", map[string]any{"approved": rv.Approved, "critique": rv.Critique})
			if rv.Approved {
				learn(ctx, taskID, l, memory, mission, failures, result.Summary, attempt, opts.Identity)
				shareMemories(ctx, taskID, l, memory, opts.Identity, reply.Remember)
				status = "completed"
			} else {
				problem = "reviewer rejected: " + rv.Critique
			}
		}
		if status != "completed" {
			attemptSpan.SetStatus(codes.Error, problem)
		}
		attemptSpan.End()
		if status == "completed" {
			break
		}

		failures = append(failures, problem)
		previousProblem = problem
		l.Append("attempt_failed", &taskID, peer, map[string]any{"attempt": attempt, "problem": problem})
		if attempt < opts.MaxAttempts && policy.ShouldEscalate(ctx, l, taskID, problem) {
			reason = "a retry cannot fix this"
			break
		}
	}
	if attempt > opts.MaxAttempts { // loop ran to exhaustion
		attempt = opts.MaxAttempts
	}

	l.UpdateTask(taskID, &status, nil)
	if status == "completed" {
		l.Append("task_completed", &taskID, "", map[string]any{"attempts": attempt, "reply": lastReply})
	} else {
		l.Append("escalated", &taskID, "", map[string]any{"reason": reason, "failures": failures})
	}
	policy.RecordOutcome(l, taskID, tier, status, attempt)
	taskSpan.SetAttributes(attribute.String("ramlaal.status", status), attribute.Int("ramlaal.attempts", attempt))
	slog.InfoContext(ctx, "task finished", "task_id", taskID, "status", status, "attempts", attempt, "tier", tier)
	return status
}

func learn(ctx context.Context, taskID int64, l *Ledger, memory MemoryClient, mission string, failures []string, summary string, attempt int, who Identity) {
	kind := "procedure"
	if len(failures) > 0 {
		kind = "lesson"
	}
	text := fmt.Sprintf("Task: %s\n", mission)
	if len(failures) > 0 {
		text += fmt.Sprintf("Initial problem: %s\n", head(failures[0], 600))
	}
	text += "What worked: " + head(strings.TrimSpace(summary), 1200)
	id, err := memory.Add(ctx, text, map[string]any{"kind": kind, "task_id": taskID, "attempts": attempt, "instance": who.Instance, "purpose": who.Purpose})
	if err != nil {
		l.Append("memory_error", &taskID, "memory", map[string]any{"op": "add", "error": err.Error()})
		return
	}
	l.Append("memory_written", &taskID, "memory", map[string]any{"id": id, "memory_kind": kind})
}
