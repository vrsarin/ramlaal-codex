package ramlaal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHomeAssistantStates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/states" || r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "bad", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode([]HAState{{EntityID: "light.kitchen", State: "on"}})
	}))
	defer srv.Close()

	states, err := NewHomeAssistant(srv.URL+"/", "tok").States(context.Background())
	if err != nil || len(states) != 1 || states[0].EntityID != "light.kitchen" || states[0].State != "on" {
		t.Fatalf("States() = %+v, %v", states, err)
	}
}

func TestHomeAssistantCallService(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.Method + " " + r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	ha := NewHomeAssistant(srv.URL, "tok")
	if err := ha.CallService(context.Background(), "light", "turn_on", map[string]any{"entity_id": "light.kitchen"}); err != nil {
		t.Fatal(err)
	}
	if gotPath != "POST /api/services/light/turn_on" || gotBody["entity_id"] != "light.kitchen" {
		t.Fatalf("got %s %v", gotPath, gotBody)
	}
}

func TestHomeAssistantRejectsBadServiceNames(t *testing.T) {
	ha := NewHomeAssistant("http://127.0.0.1:1", "tok")
	for _, c := range [][2]string{{"light/../x", "turn_on"}, {"light", "turn-on"}, {"", "turn_on"}} {
		if err := ha.CallService(context.Background(), c[0], c[1], nil); err == nil {
			t.Errorf("CallService(%q, %q) accepted an invalid name", c[0], c[1])
		}
	}
}

func TestHomeAssistantRequiresToken(t *testing.T) {
	if _, err := NewHomeAssistant("http://127.0.0.1:1", "").States(context.Background()); err == nil {
		t.Fatal("expected an error without HA_TOKEN")
	}
}

func TestHomeAssistantFromEnv(t *testing.T) {
	if HomeAssistantFromEnv(map[string]string{}) != nil {
		t.Fatal("HA_URL unset should disable Home Assistant")
	}
	if HomeAssistantFromEnv(map[string]string{"HA_URL": "http://ha:8123"}) == nil {
		t.Fatal("HA_URL set should enable Home Assistant")
	}
}
