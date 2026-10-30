package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2asrv"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"ramlaal/orchestrator/auth"
	"ramlaal/orchestrator/ramlaal"
	"ramlaal/orchestrator/swarm"
	"ramlaal/orchestrator/telemetry"
)

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s, err := ramlaal.ServerFromEnv()
	if err == nil {
		flush := telemetry.Setup(ctx, "orchestrator", s.Identity.Instance)
		defer func() {
			c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = flush(c)
		}()
	}
	if err != nil {
		log.Fatal(err)
	}

	var verifier auth.Verifier
	authCfg := auth.ConfigFromEnv(os.Getenv)
	if authCfg != nil {
		verifier = auth.NewOIDC(*authCfg)
	} else {
		log.Print("WARNING: AUTH_ISSUER is not set: authentication is off and every caller is the single local user")
	}
	s.Auth = verifier

	listen := envOr("SWARM_LISTEN", ":9000")
	advertise := os.Getenv("SWARM_ADVERTISE")
	if advertise == "" {
		host, _ := os.Hostname()
		advertise = host + ":" + strings.TrimPrefix(listen, ":")
	}
	nodeCfg := swarm.Config{
		Identity: s.Identity, NATSURL: os.Getenv("NATS_URL"), ListenAddr: listen, AdvertiseAddr: advertise,
		Auth:   verifier,
		Handle: s.RunRequest,
	}
	if id := os.Getenv("SWARM_CLIENT_ID"); id != "" && authCfg != nil {
		tokenURL := envOr("AUTH_TOKEN_URL", strings.TrimRight(authCfg.DiscoveryURL, "/")+"/protocol/openid-connect/token")
		creds := auth.NewPeerCredentials(tokenURL, id, os.Getenv("SWARM_CLIENT_SECRET"))
		nodeCfg.PeerCreds = creds
		s.ServiceToken = creds.Token // the gateway and memory service are protected by the same realm
	} else if authCfg != nil {
		log.Print("WARNING: SWARM_CLIENT_ID is not set: the gateway, the memory service and peers that require authentication will reject this instance")
	}
	node, err := swarm.Start(nodeCfg)
	if err != nil {
		log.Fatal(err)
	}
	defer node.Close()
	if nodeCfg.NATSURL != "" {
		s.Delegator = node
	}
	log.Printf("instance %q capabilities %v: A2A gRPC on %s, swarm %q", s.Identity.Instance, s.Identity.Capabilities, advertise, nodeCfg.NATSURL)

	mux := http.NewServeMux()
	mux.Handle("GET "+a2asrv.WellKnownAgentCardPath, ramlaal.WithCORS(node.CardHandler()))
	mux.Handle("/a2a", ramlaal.WithCORS(auth.Middleware(verifier, node.HTTPHandler())))
	mux.Handle("/", s.Handler())

	addr := ":" + envOr("PORT", "8000")
	srv := &http.Server{Addr: addr, Handler: otelhttp.NewHandler(mux, "orchestrator", otelhttp.WithFilter(func(r *http.Request) bool {
		return r.URL.Path != "/healthz" && r.URL.Path != "/stream" && r.URL.Path != "/events"
	})), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("orchestrator listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
