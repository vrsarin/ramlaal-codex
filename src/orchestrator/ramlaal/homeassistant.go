package ramlaal

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// HAState is one entity as reported by the Home Assistant REST API.
type HAState struct {
	EntityID   string         `json:"entity_id"`
	State      string         `json:"state"`
	Attributes map[string]any `json:"attributes"`
}

// HomeAssistant talks to the Home Assistant REST API with a long-lived access token.
type HomeAssistant struct {
	base   string
	token  string
	client *http.Client
}

var haNameRe = regexp.MustCompile(`^[a-z0-9_]+$`)

// HomeAssistantFromEnv reads HA_URL and HA_TOKEN. It returns nil when HA_URL is unset, so instances
// without Home Assistant behave as before.
func HomeAssistantFromEnv(env map[string]string) *HomeAssistant {
	if env["HA_URL"] == "" {
		return nil
	}
	return NewHomeAssistant(env["HA_URL"], env["HA_TOKEN"])
}

func NewHomeAssistant(baseURL, token string) *HomeAssistant {
	return &HomeAssistant{base: strings.TrimRight(baseURL, "/"), token: token, client: &http.Client{Timeout: 30 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)}}
}

func (h *HomeAssistant) do(ctx context.Context, method, path string, body any, out any) error {
	if h.token == "" {
		return fmt.Errorf("home assistant: HA_TOKEN is not set")
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, h.base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+h.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("home assistant unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("home assistant: status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

// States lists every entity and its current state (GET /api/states).
func (h *HomeAssistant) States(ctx context.Context) ([]HAState, error) {
	var out []HAState
	if err := h.do(ctx, http.MethodGet, "/api/states", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// CallService runs domain.service with data, e.g. ("light", "turn_on", {"entity_id": "light.kitchen"}).
// The names are validated so they cannot change the request path.
func (h *HomeAssistant) CallService(ctx context.Context, domain, service string, data map[string]any) error {
	if !haNameRe.MatchString(domain) || !haNameRe.MatchString(service) {
		return fmt.Errorf("home assistant: invalid service %q.%q", domain, service)
	}
	if data == nil {
		data = map[string]any{}
	}
	return h.do(ctx, http.MethodPost, "/api/services/"+domain+"/"+service, data, nil)
}
