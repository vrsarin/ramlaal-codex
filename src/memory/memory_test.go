package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeStore struct {
	added []string
	limit int
}

func (f *fakeStore) Add(_ context.Context, text string, _ map[string]any) (string, error) {
	f.added = append(f.added, text)
	return "m1", nil
}

func (f *fakeStore) Search(_ context.Context, _ string, limit int) ([]Hit, error) {
	f.limit = limit
	return []Hit{{ID: "m1", Text: "use range(n+1)", Score: 0.9, Metadata: map[string]any{"kind": "lesson"}}}, nil
}

func post(h http.Handler, path, body, authz string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if authz != "" {
		req.Header.Set("Authorization", authz)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAddAndSearch(t *testing.T) {
	s := &fakeStore{}
	h := NewHandler(s, nil)

	rec := post(h, "/add", `{"text":"lesson text","metadata":{"kind":"lesson"}}`, "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"id":"m1"`) || s.added[0] != "lesson text" {
		t.Fatalf("add: %d %s", rec.Code, rec.Body)
	}

	rec = post(h, "/search", `{"query":"pagination","limit":3}`, "")
	var out struct{ Results []Hit }
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 200 || len(out.Results) != 1 || out.Results[0].Text != "use range(n+1)" || s.limit != 3 {
		t.Fatalf("search: %d %s limit=%d", rec.Code, rec.Body, s.limit)
	}
}

func TestSearchLimitDefaultsAndClamps(t *testing.T) {
	s := &fakeStore{}
	h := NewHandler(s, nil)
	post(h, "/search", `{"query":"q"}`, "")
	if s.limit != defaultLimit {
		t.Fatalf("default limit = %d", s.limit)
	}
	post(h, "/search", `{"query":"q","limit":100000}`, "")
	if s.limit != maxLimit {
		t.Fatalf("clamped limit = %d", s.limit)
	}
}

func TestBadInputRejected(t *testing.T) {
	h := NewHandler(&fakeStore{}, nil)
	for _, c := range [][2]string{{"/add", `{"text":" "}`}, {"/add", `nope`}, {"/search", `{}`}} {
		if rec := post(h, c[0], c[1], ""); rec.Code != 422 {
			t.Errorf("%s %s -> %d", c[0], c[1], rec.Code)
		}
	}
}

type fakeAuthn struct{}

func (fakeAuthn) Authenticate(_ context.Context, authz string) error {
	if authz == "Bearer peer" {
		return nil
	}
	return errors.New("rejected")
}

func TestAuth(t *testing.T) {
	h := NewHandler(&fakeStore{}, fakeAuthn{})
	if rec := post(h, "/add", `{"text":"x"}`, ""); rec.Code != 401 {
		t.Fatalf("missing token -> %d", rec.Code)
	}
	if rec := post(h, "/add", `{"text":"x"}`, "Bearer user"); rec.Code != 401 {
		t.Fatalf("wrong token -> %d", rec.Code)
	}
	if rec := post(h, "/search", `{"query":"x"}`, "Bearer user"); rec.Code != 401 {
		t.Fatalf("search with wrong token -> %d", rec.Code)
	}
	if rec := post(h, "/add", `{"text":"x"}`, "Bearer peer"); rec.Code != 200 {
		t.Fatalf("right token -> %d", rec.Code)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != 200 {
		t.Fatalf("health must not need auth: %d", rec.Code)
	}
}
func TestVectorLiteral(t *testing.T) {
	if got := vectorLiteral([]float32{0.5, -1, 2.25}); got != "[0.5,-1,2.25]" {
		t.Fatalf("got %s", got)
	}
}

func TestOllamaEmbedder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/embed" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"embeddings":[[0.1,0.2,0.3]]}`))
	}))
	defer srv.Close()

	v, err := NewOllamaEmbedder(srv.URL, "m", 3, 2).Embed(context.Background(), "hi")
	if err != nil || len(v) != 3 {
		t.Fatalf("embed: %v %v", v, err)
	}
	if _, err := NewOllamaEmbedder(srv.URL, "m", 4, 2).Embed(context.Background(), "hi"); err == nil {
		t.Fatal("expected dimension mismatch error")
	}
}
