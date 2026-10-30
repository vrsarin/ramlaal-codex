package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

const (
	defaultLimit = 5
	maxLimit     = 100
	maxBodyBytes = 1 << 20
)

// NewHandler serves /health, /add and /search. A nil Authenticator disables auth.
func NewHandler(store Store, authn Authenticator) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.Handle("POST /add", protect(authn, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Text     string         `json:"text"`
			Metadata map[string]any `json:"metadata"`
		}
		if !decode(w, r, &in) {
			return
		}
		if strings.TrimSpace(in.Text) == "" {
			writeError(w, http.StatusUnprocessableEntity, "text is required")
			return
		}
		id, err := store.Add(r.Context(), in.Text, in.Metadata)
		if err != nil {
			log.Printf("add failed: %v", err)
			writeError(w, http.StatusBadGateway, "add failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": id})
	})))
	mux.Handle("POST /search", protect(authn, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if !decode(w, r, &in) {
			return
		}
		if strings.TrimSpace(in.Query) == "" {
			writeError(w, http.StatusUnprocessableEntity, "query is required")
			return
		}
		if in.Limit <= 0 {
			in.Limit = defaultLimit
		}
		if in.Limit > maxLimit {
			in.Limit = maxLimit
		}
		hits, err := store.Search(r.Context(), in.Query, in.Limit)
		if err != nil {
			log.Printf("search failed: %v", err)
			writeError(w, http.StatusBadGateway, "search failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": hits})
	})))
	return mux
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"detail": msg})
}
