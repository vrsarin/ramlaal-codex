package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// Authenticator checks the Authorization header of a request. A nil Authenticator disables auth.
type Authenticator interface {
	Authenticate(ctx context.Context, authorization string) error
}

// OIDCAuth accepts Keycloak access tokens of service accounts that hold the peer role. The
// memory service is only called by Ramlaal instances, never directly by users.
type OIDCAuth struct {
	Issuer, DiscoveryURL, Audience, PeerRole string

	mu sync.Mutex
	v  *oidc.IDTokenVerifier
}

// OIDCAuthFromEnv reads AUTH_ISSUER, AUTH_DISCOVERY_URL, AUTH_AUDIENCE and AUTH_PEER_ROLE.
// It returns nil when AUTH_ISSUER is unset.
func OIDCAuthFromEnv(get func(string) string) *OIDCAuth {
	if get("AUTH_ISSUER") == "" {
		return nil
	}
	a := &OIDCAuth{Issuer: get("AUTH_ISSUER"), DiscoveryURL: get("AUTH_DISCOVERY_URL"), Audience: get("AUTH_AUDIENCE"), PeerRole: get("AUTH_PEER_ROLE")}
	if a.DiscoveryURL == "" {
		a.DiscoveryURL = a.Issuer
	}
	if a.PeerRole == "" {
		a.PeerRole = "swarm-peer"
	}
	return a
}

func (a *OIDCAuth) verifier() (*oidc.IDTokenVerifier, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.v != nil {
		return a.v, nil
	}
	ctx := oidc.ClientContext(context.Background(), &http.Client{Timeout: 10 * time.Second})
	if a.DiscoveryURL != a.Issuer {
		ctx = oidc.InsecureIssuerURLContext(ctx, a.Issuer)
	}
	p, err := oidc.NewProvider(ctx, a.DiscoveryURL)
	if err != nil {
		return nil, err
	}
	a.v = p.Verifier(&oidc.Config{ClientID: a.Audience, SkipClientIDCheck: a.Audience == ""})
	return a.v, nil
}

func (a *OIDCAuth) Authenticate(ctx context.Context, authorization string) error {
	raw, ok := strings.CutPrefix(authorization, "Bearer ")
	if !ok || raw == "" {
		return errors.New("missing bearer token")
	}
	vf, err := a.verifier()
	if err != nil {
		return err
	}
	tok, err := vf.Verify(ctx, raw)
	if err != nil {
		return err
	}
	var c struct {
		RealmAccess struct {
			Roles []string `json:"roles"`
		} `json:"realm_access"`
	}
	if err := tok.Claims(&c); err != nil {
		return err
	}
	for _, r := range c.RealmAccess.Roles {
		if r == a.PeerRole {
			return nil
		}
	}
	return errors.New("token is not a service account")
}

func protect(a Authenticator, next http.Handler) http.Handler {
	if a == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := a.Authenticate(r.Context(), r.Header.Get("Authorization")); err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}
