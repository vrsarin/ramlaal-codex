package ramlaal

import (
	"context"
	"fmt"

	"ramlaal/orchestrator/auth"
)

// RunRequest runs a request that arrived over A2A to completion for the user in ctx and returns
// the reply. It runs without a Delegator, so a delegated request is never re-delegated:
// delegation depth is one, which rules out loops between instances.
func (s *Server) RunRequest(ctx context.Context, request string) (string, error) {
	s.defaults()
	user := auth.UserFrom(ctx)
	if user == "" {
		user = auth.DevUser
	}
	l := s.Ledgers.For(user)
	id := l.CreateTask(request, s.DefaultWorkspace, nil)
	runner := s.NewRunner()
	status := RunTask(ctx, id, l, runner, NewCodexReviewer(runner, s.Policy.ReviewModel()), s.NewMemory(),
		RunOptions{MaxAttempts: s.MaxAttempts, Policy: s.Policy, Identity: s.Identity, User: user})
	if status != "completed" {
		reason := "task escalated"
		if ev := payloads(l, id, "escalated"); len(ev) > 0 {
			reason = fmt.Sprint(ev[0]["reason"], " ", ev[0]["failures"])
		}
		return "", fmt.Errorf("%s", reason)
	}
	if ev := payloads(l, id, "task_completed"); len(ev) > 0 {
		reply, _ := ev[0]["reply"].(string)
		return reply, nil
	}
	return "", nil
}

// payloads returns the payloads of a task's events of one kind.
func payloads(l *Ledger, taskID int64, kind string) []map[string]any {
	out := []map[string]any{}
	for _, e := range l.Events(0, &taskID, 0) {
		if e.Kind == kind {
			out = append(out, e.Payload)
		}
	}
	return out
}
