package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fake map[string]Principal

func (f fake) Verify(_ context.Context, tok string) (Principal, error) {
	if p, ok := f[tok]; ok {
		return p, nil
	}
	return Principal{}, errors.New("bad token")
}

func TestResolve(t *testing.T) {
	v := fake{"user": {Subject: "alice"}, "peer": {Subject: "svc", Peer: true}}
	ctx := context.Background()
	cases := []struct {
		name, authz, onBehalf, want string
		err                         bool
	}{
		{"user token", "Bearer user", "", "alice", false},
		{"a user cannot impersonate", "Bearer user", "bob", "alice", false},
		{"peer acts for a user", "Bearer peer", "bob", "bob", false},
		{"peer without a user", "Bearer peer", "", SystemUser, false},
		{"missing", "", "", "", true},
		{"wrong scheme", "Basic x", "", "", true},
		{"unknown token", "Bearer nope", "", "", true},
	}
	for _, c := range cases {
		got, err := Resolve(ctx, v, c.authz, c.onBehalf)
		if (err != nil) != c.err || got != c.want {
			t.Errorf("%s: got %q, %v", c.name, got, err)
		}
	}
	if got, _ := Resolve(ctx, nil, "", ""); got != DevUser {
		t.Errorf("auth off should be the dev user, got %q", got)
	}
}

func TestMiddlewareSetsUserAndSkipsPublicPaths(t *testing.T) {
	seen := ""
	h := Middleware(fake{"t": {Subject: "alice"}}, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen = UserFrom(r.Context())
	}), "/open")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer t")
	h.ServeHTTP(rec, req)
	if seen != "alice" || rec.Code != http.StatusOK {
		t.Fatalf("seen=%q code=%d", seen, rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token -> %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/open", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("public path -> %d", rec.Code)
	}

	// Only /stream may use the query-string token.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x?access_token=t", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("query token on /x -> %d", rec.Code)
	}
}
