package ramlaal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	"go.opentelemetry.io/otel/trace"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"ramlaal/orchestrator/auth"
)

// Server is the HTTP API + SSE feed for the observer UI.
type Server struct {
	Ledgers    *Ledgers      // one in-memory ledger per user
	Auth       auth.Verifier // nil disables authentication (single local user)
	Policy     *Policy
	GatewayURL string
	MemoryURL  string
	// ServiceToken returns this instance's Keycloak service-account token for the gateway and memory;
	// nil sends no credentials (auth disabled).
	ServiceToken     func() (string, error)
	MaxAttempts      int
	DefaultWorkspace string
	Identity         Identity
	Delegator        Delegator // set when this instance is part of a swarm
	// NewRunner and NewMemory build the per-task peers; tests override them.
	NewRunner func() Runner
	NewMemory func() MemoryClient
}

var corsOrigins = map[string]bool{"http://127.0.0.1:5173": true, "http://localhost:5173": true}

// ServerFromEnv reads GATEWAY_URL, MEMORY_URL, RAMONA_MEMORY_TOKEN, MAX_ATTEMPTS, DEFAULT_WORKSPACE
// and the policy variables.
func ServerFromEnv() (*Server, error) {
	env := osEnvMap()
	get := func(k, def string) string {
		if v := env[k]; v != "" {
			return v
		}
		return def
	}
	policy, err := PolicyFromEnv(env)
	if err != nil {
		return nil, err
	}
	max, err := strconv.Atoi(get("MAX_ATTEMPTS", "3"))
	if err != nil {
		return nil, fmt.Errorf("MAX_ATTEMPTS: %w", err)
	}
	ws := env["DEFAULT_WORKSPACE"]
	if ws == "" { // like the real CLI: work in the folder the service started from
		ws, _ = os.Getwd()
	}
	s := &Server{
		Ledgers: NewLedgers(), Policy: policy, MaxAttempts: max, DefaultWorkspace: ws, Identity: IdentityFromEnv(env),
		GatewayURL: get("GATEWAY_URL", "http://127.0.0.1:8090"),
		MemoryURL:  get("MEMORY_URL", "http://127.0.0.1:8080"),
	}
	return s, nil
}

// bearer adds the service token, if there is one, to an outgoing request.
func bearer(req *http.Request, token func() (string, error)) error {
	if token == nil {
		return nil
	}
	t, err := token()
	if err != nil {
		return fmt.Errorf("service token: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+t)
	return nil
}

// defaults builds the per-task runner and memory client unless a test supplied them.
func (s *Server) defaults() {
	if s.NewRunner == nil {
		s.NewRunner = func() Runner { return NewGatewayRunner(s.GatewayURL, s.ServiceToken) }
	}
	if s.NewMemory == nil {
		s.NewMemory = func() MemoryClient { return NewHttpMemory(s.MemoryURL, s.ServiceToken) }
	}
}

func (s *Server) Handler() http.Handler {
	s.defaults()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, map[string]any{}) })
	mux.HandleFunc("GET /config", s.config)
	mux.HandleFunc("POST /tasks", s.createTask)
	mux.HandleFunc("GET /tasks", s.listTasks)
	mux.HandleFunc("GET /stats", s.stats)
	mux.HandleFunc("POST /replay", s.replay)
	mux.HandleFunc("GET /events", s.events)
	mux.HandleFunc("GET /stream", s.stream)
	mux.HandleFunc("POST /approvals/{id...}", s.approve)
	return cors(auth.Middleware(s.Auth, mux, "/healthz"))
}

// ledger is the calling user's ledger.
func (s *Server) ledger(r *http.Request) *Ledger {
	user := auth.UserFrom(r.Context())
	if user == "" {
		user = auth.DevUser
	}
	return s.Ledgers.For(user)
}

// WithCORS lets the browser UI call a handler from its own origin.
func WithCORS(next http.Handler) http.Handler { return cors(next) }

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); corsOrigins[o] {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "*")
				w.Header().Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
				w.WriteHeader(http.StatusOK)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, map[string]string{"detail": detail})
}

func (s *Server) config(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"default_workspace": s.DefaultWorkspace})
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Mission       string  `json:"mission"`
		Workspace     *string `json:"workspace"`
		VerifyCommand *string `json:"verify_command"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil || in.Mission == "" {
		writeError(w, http.StatusUnprocessableEntity, "mission is required")
		return
	}
	workspace := s.DefaultWorkspace
	if in.Workspace != nil && strings.TrimSpace(*in.Workspace) != "" {
		workspace = strings.TrimSpace(*in.Workspace)
	}
	l, user := s.ledger(r), userOf(r.Context())
	id := l.CreateTask(in.Mission, workspace, in.VerifyCommand)
	runner := s.NewRunner()
	// the task outlives the request, so keep only its trace link, not its cancellation
	taskCtx := trace.ContextWithSpanContext(context.Background(), trace.SpanContextFromContext(r.Context()))
	go func() {
		defer func() { // a failed task must never take the service down
			if rec := recover(); rec != nil {
				log.Printf("task %d crashed: %v", id, rec)
				failed := "escalated"
				l.UpdateTask(id, &failed, nil)
				l.Append("escalated", &id, "", map[string]any{"reason": fmt.Sprint(rec), "failures": []string{}})
			}
		}()
		RunTask(taskCtx, id, l, runner, NewCodexReviewer(runner, s.Policy.ReviewModel()), s.NewMemory(),
			RunOptions{MaxAttempts: s.MaxAttempts, Policy: s.Policy, Identity: s.Identity, Delegator: s.Delegator, User: user})
	}()
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.ledger(r).Tasks())
}

// stats reports spend and routing effectiveness for the calling user.
func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	l := s.ledger(r)
	tasks := l.Tasks()
	type tier struct {
		Tasks      int `json:"tasks"`
		FirstTryOK int `json:"first_try_ok"`
	}
	byTier := map[string]*tier{}
	for _, e := range l.Recent("route_outcome", 200) {
		name, _ := e.Payload["tier"].(string)
		t := byTier[name]
		if t == nil {
			t = &tier{}
			byTier[name] = t
		}
		t.Tasks++
		if ok, _ := e.Payload["first_try_ok"].(bool); ok {
			t.FirstTryOK++
		}
	}
	total := 0.0
	for _, t := range tasks {
		total += t.CostUSD
	}
	writeJSON(w, http.StatusOK, map[string]any{"total_cost_usd": total, "tasks": len(tasks), "by_tier": byTier})
}

// replay is the offline scripted demo of heal + learn, no model calls.
func (s *Server) replay(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ids": RunDemo(s.ledger(r), NewInMemoryMemory())})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	var taskID *int64
	if v := r.URL.Query().Get("task_id"); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "task_id must be an integer")
			return
		}
		taskID = &id
	}
	writeJSON(w, http.StatusOK, s.ledger(r).Events(after, taskID, 500))
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	l := s.ledger(r)
	cursor, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if v := r.Header.Get("Last-Event-ID"); v != "" && cursor == 0 {
		cursor, _ = strconv.ParseInt(v, 10, 64)
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fl.Flush()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		batch := l.Events(cursor, nil, 500)
		for _, e := range batch {
			cursor = e.ID
			raw, _ := json.Marshal(e)
			fmt.Fprintf(w, "id: %d\ndata: %s\n\n", e.ID, raw)
		}
		if len(batch) == 0 {
			fmt.Fprint(w, ": keepalive\n\n")
		}
		fl.Flush()
		if len(batch) == 500 {
			continue // more waiting; do not sleep
		}
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		}
	}
}

func (s *Server) approve(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Decision string `json:"decision"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "decision is required")
		return
	}
	id := r.PathValue("id")
	if !s.ledger(r).HasApproval(id) {
		writeError(w, http.StatusNotFound, "unknown or expired approval")
		return
	}
	body, _ := json.Marshal(map[string]string{"decision": in.Decision})
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, strings.TrimRight(s.GatewayURL, "/")+"/approvals/"+url.PathEscape(id), bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if err := bearer(req, s.ServiceToken); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		writeError(w, resp.StatusCode, string(msg))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{})
}

// userOf is the acting user, defaulting to the single local user.
func userOf(ctx context.Context) string {
	if u := auth.UserFrom(ctx); u != "" {
		return u
	}
	return auth.DevUser
}
