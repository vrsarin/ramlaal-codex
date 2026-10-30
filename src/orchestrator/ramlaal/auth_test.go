package ramlaal

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ramlaal/orchestrator/auth"
)

type fakeAuth map[string]auth.Principal

func (f fakeAuth) Verify(_ context.Context, tok string) (auth.Principal, error) {
	if p, ok := f[tok]; ok {
		return p, nil
	}
	return auth.Principal{}, errors.New("bad token")
}

func TestServerRequiresTokenAndIsolatesUsers(t *testing.T) {
	s := &Server{
		Ledgers: NewLedgers(), Policy: NewPolicy(), Auth: fakeAuth{"a": {Subject: "alice"}, "b": {Subject: "bob"}},
	}
	h := s.Handler()
	do := func(method, path, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if c := do(http.MethodGet, "/tasks", "").Code; c != http.StatusUnauthorized {
		t.Fatalf("no token -> %d", c)
	}
	if c := do(http.MethodGet, "/tasks", "nope").Code; c != http.StatusUnauthorized {
		t.Fatalf("bad token -> %d", c)
	}
	if c := do(http.MethodGet, "/healthz", "").Code; c != http.StatusOK {
		t.Fatalf("healthz -> %d", c)
	}
	if c := do(http.MethodPost, "/replay", "a").Code; c != http.StatusOK {
		t.Fatalf("replay -> %d", c)
	}
	if body := do(http.MethodGet, "/tasks", "a").Body.String(); !strings.Contains(body, "mission") {
		t.Errorf("alice should see her tasks: %s", body)
	}
	if body := strings.TrimSpace(do(http.MethodGet, "/tasks", "b").Body.String()); body != "[]" {
		t.Errorf("bob must not see alice's tasks: %s", body)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the stream sends its first batch, then returns because the client is gone
	req := httptest.NewRequest(http.MethodGet, "/stream?access_token=a", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code == http.StatusUnauthorized {
		t.Error("the stream must accept the token as a query parameter")
	}
}

func TestApprovalsAreScopedToTheirUser(t *testing.T) {
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer svc-token" {
			http.Error(w, "no service token", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	defer gw.Close()
	ls := NewLedgers()
	ls.For("alice").Append("codex", nil, "worker", map[string]any{"type": "approval_request", "approvalId": "t:1"})
	s := &Server{
		Ledgers: ls, Policy: NewPolicy(), GatewayURL: gw.URL,
		Auth:         fakeAuth{"a": {Subject: "alice"}, "b": {Subject: "bob"}},
		ServiceToken: func() (string, error) { return "svc-token", nil },
	}
	h := s.Handler()
	post := func(token string) int {
		req := httptest.NewRequest(http.MethodPost, "/approvals/t:1", strings.NewReader(`{"decision":"accept"}`))
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := post("b"); c != http.StatusNotFound {
		t.Errorf("bob approving alice's request -> %d", c)
	}
	if c := post("a"); c != http.StatusOK {
		t.Errorf("alice approving her own request -> %d", c)
	}
}
