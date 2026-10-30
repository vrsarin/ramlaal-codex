// Package auth identifies the user behind every request.
//
// Users sign in with Keycloak (OIDC) and call Ramlaal with their access token; the token's `sub`
// is the user id everything else is partitioned by. Swarm instances call each other with a
// service-account token that carries the swarm-peer realm role, and name the user they act for in
// the x-ramlaal-user header. Only peers may act on behalf of a user; a user token never can.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const (
	// UserHeader names the user a peer instance acts for.
	UserHeader = "x-ramlaal-user"
	// SystemUser owns work a peer starts on its own, with no user behind it.
	SystemUser = "system"
	// DevUser is the only user when authentication is not configured.
	DevUser = "local"
)

// ErrUnauthenticated is returned when credentials are missing or invalid.
var ErrUnauthenticated = errors.New("unauthenticated")

// Principal is a verified caller.
type Principal struct {
	Subject string
	Peer    bool // a swarm service account
}

// Verifier validates a bearer token. A nil Verifier means authentication is disabled.
type Verifier interface {
	Verify(ctx context.Context, rawToken string) (Principal, error)
}

type userKey struct{}

// WithUser returns a context carrying the acting user.
func WithUser(ctx context.Context, user string) context.Context {
	return context.WithValue(ctx, userKey{}, user)
}

// UserFrom returns the acting user, or "" when there is none.
func UserFrom(ctx context.Context) string {
	u, _ := ctx.Value(userKey{}).(string)
	return u
}

// Resolve turns request credentials into the acting user.
func Resolve(ctx context.Context, v Verifier, authorization, onBehalfOf string) (string, error) {
	if v == nil {
		if onBehalfOf != "" {
			return onBehalfOf, nil
		}
		return DevUser, nil
	}
	raw, ok := strings.CutPrefix(authorization, "Bearer ")
	if !ok || raw == "" {
		return "", ErrUnauthenticated
	}
	p, err := v.Verify(ctx, raw)
	if err != nil {
		return "", ErrUnauthenticated
	}
	if p.Peer {
		if onBehalfOf != "" {
			return onBehalfOf, nil
		}
		return SystemUser, nil
	}
	return p.Subject, nil
}

// Config selects the Keycloak realm to trust.
type Config struct {
	Issuer       string // the `iss` of issued tokens, e.g. http://localhost:8180/realms/ramlaal
	DiscoveryURL string // where this process reaches the realm; defaults to Issuer
	Audience     string // required `aud`; empty skips the check
	PeerRole     string // realm role marking swarm service accounts; default swarm-peer
}

// ConfigFromEnv reads AUTH_ISSUER, AUTH_DISCOVERY_URL, AUTH_AUDIENCE and AUTH_PEER_ROLE.
// It returns nil when AUTH_ISSUER is unset, which disables authentication.
func ConfigFromEnv(get func(string) string) *Config {
	if get("AUTH_ISSUER") == "" {
		return nil
	}
	c := &Config{Issuer: get("AUTH_ISSUER"), DiscoveryURL: get("AUTH_DISCOVERY_URL"), Audience: get("AUTH_AUDIENCE"), PeerRole: get("AUTH_PEER_ROLE")}
	if c.DiscoveryURL == "" {
		c.DiscoveryURL = c.Issuer
	}
	if c.PeerRole == "" {
		c.PeerRole = "swarm-peer"
	}
	return c
}

// OIDC verifies Keycloak access tokens. Discovery is lazy so Ramlaal can start before Keycloak.
type OIDC struct {
	cfg Config
	mu  sync.Mutex
	v   *oidc.IDTokenVerifier
}

func NewOIDC(cfg Config) *OIDC {
	if cfg.DiscoveryURL == "" {
		cfg.DiscoveryURL = cfg.Issuer
	}
	if cfg.PeerRole == "" {
		cfg.PeerRole = "swarm-peer"
	}
	return &OIDC{cfg: cfg}
}

func (o *OIDC) verifier() (*oidc.IDTokenVerifier, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.v != nil {
		return o.v, nil
	}
	// The provider keeps this context for later key fetches, so it must outlive the request.
	ctx := oidc.ClientContext(context.Background(), &http.Client{Timeout: 10 * time.Second})
	if o.cfg.DiscoveryURL != o.cfg.Issuer {
		ctx = oidc.InsecureIssuerURLContext(ctx, o.cfg.Issuer)
	}
	p, err := oidc.NewProvider(ctx, o.cfg.DiscoveryURL)
	if err != nil {
		return nil, err
	}
	o.v = p.Verifier(&oidc.Config{ClientID: o.cfg.Audience, SkipClientIDCheck: o.cfg.Audience == ""})
	return o.v, nil
}

func (o *OIDC) Verify(ctx context.Context, raw string) (Principal, error) {
	vf, err := o.verifier()
	if err != nil {
		return Principal{}, err
	}
	tok, err := vf.Verify(ctx, raw)
	if err != nil {
		return Principal{}, err
	}
	var c struct {
		RealmAccess struct {
			Roles []string `json:"roles"`
		} `json:"realm_access"`
	}
	if err := tok.Claims(&c); err != nil {
		return Principal{}, err
	}
	p := Principal{Subject: tok.Subject}
	for _, r := range c.RealmAccess.Roles {
		p.Peer = p.Peer || r == o.cfg.PeerRole
	}
	if p.Subject == "" {
		return Principal{}, ErrUnauthenticated
	}
	return p, nil
}

// Middleware authenticates HTTP requests and stores the acting user in the request context.
// OPTIONS requests and the public paths pass through. EventSource cannot set headers, so
// /stream also accepts the token as ?access_token=.
func Middleware(v Verifier, next http.Handler, public ...string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		for _, p := range public {
			if r.URL.Path == p {
				next.ServeHTTP(w, r)
				return
			}
		}
		authz := r.Header.Get("Authorization")
		if authz == "" && r.URL.Path == "/stream" {
			if t := r.URL.Query().Get("access_token"); t != "" {
				authz = "Bearer " + t
			}
		}
		user, err := Resolve(r.Context(), v, authz, r.Header.Get(UserHeader))
		if err != nil {
			w.Header().Set("WWW-Authenticate", "Bearer")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"detail": "authentication required"})
			return
		}
		next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), user)))
	})
}

func fromMetadata(ctx context.Context, v Verifier) (context.Context, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	first := func(k string) string {
		if vals := md.Get(k); len(vals) > 0 {
			return vals[0]
		}
		return ""
	}
	user, err := Resolve(ctx, v, first("authorization"), first(UserHeader))
	if err != nil {
		return nil, status.Error(codes.Unauthenticated, "authentication required")
	}
	return WithUser(ctx, user), nil
}

// UnaryInterceptor authenticates unary gRPC calls.
func UnaryInterceptor(v Verifier) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, next grpc.UnaryHandler) (any, error) {
		ctx, err := fromMetadata(ctx, v)
		if err != nil {
			return nil, err
		}
		return next(ctx, req)
	}
}

type userStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (s userStream) Context() context.Context { return s.ctx }

// StreamInterceptor authenticates streaming gRPC calls.
func StreamInterceptor(v Verifier) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, _ *grpc.StreamServerInfo, next grpc.StreamHandler) error {
		ctx, err := fromMetadata(ss.Context(), v)
		if err != nil {
			return err
		}
		return next(srv, userStream{ServerStream: ss, ctx: ctx})
	}
}

// PeerCredentials authenticates outgoing swarm calls with a Keycloak service-account token
// (client-credentials grant) and names the user the call is made for.
type PeerCredentials struct {
	ts oauth2.TokenSource
}

func NewPeerCredentials(tokenURL, clientID, clientSecret string) *PeerCredentials {
	cfg := clientcredentials.Config{ClientID: clientID, ClientSecret: clientSecret, TokenURL: tokenURL}
	ctx := oidc.ClientContext(context.Background(), &http.Client{Timeout: 10 * time.Second})
	return &PeerCredentials{ts: cfg.TokenSource(ctx)} // caches and refreshes the token
}

func (p *PeerCredentials) GetRequestMetadata(ctx context.Context, _ ...string) (map[string]string, error) {
	token, err := p.Token()
	if err != nil {
		return nil, err
	}
	md := map[string]string{"authorization": "Bearer " + token}
	if u := UserFrom(ctx); u != "" {
		md[UserHeader] = u
	}
	return md, nil
}

// Token returns the cached service-account access token, for HTTP calls to other components.
func (p *PeerCredentials) Token() (string, error) {
	tok, err := p.ts.Token()
	if err != nil {
		return "", err
	}
	return tok.AccessToken, nil
}

// RequireTransportSecurity is false because the swarm runs on a private network.
func (*PeerCredentials) RequireTransportSecurity() bool { return false }
