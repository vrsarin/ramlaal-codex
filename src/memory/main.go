package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"

	"ramlaal/memory/telemetry"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	flush := telemetry.Setup(ctx, "memory", "")
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = flush(c)
	}()

	dims := envInt("EMBED_DIMS", 768)
	dsn := (&url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(env("PGUSER", "postgres"), env("PGPASSWORD", "example")),
		Host:   env("PGHOST", "pgvector") + ":" + env("PGPORT", "5432"),
		Path:   env("PGDATABASE", "postgres"),
	}).String()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Fatal(err)
	}
	cfg.MaxConns = int32(envInt("PGPOOL_MAX", 20))

	pool, err := connect(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := Migrate(ctx, pool, dims); err != nil {
		log.Fatal(err)
	}

	embed := NewOllamaEmbedder(env("OLLAMA_BASE_URL", "http://ollama:11434"), env("EMBED_MODEL", "embeddinggemma"), dims, envInt("EMBED_CONCURRENCY", 8))
	var authn Authenticator
	if a := OIDCAuthFromEnv(os.Getenv); a != nil {
		authn = a
	} else {
		log.Print("WARNING: AUTH_ISSUER is not set: the memory API is unauthenticated")
	}
	store := NewPgStore(pool, embed, env("MEMORY_USER_ID", DefaultUserID))
	srv := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           otelhttp.NewHandler(NewHandler(store, authn), "memory", otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/healthz" })),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("memory listening on %s", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// connect retries so the service can start before Postgres is ready.
func connect(ctx context.Context, cfg *pgxpool.Config) (*pgxpool.Pool, error) {
	var lastErr error
	for i := 0; i < 30; i++ {
		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				return pool, nil
			}
			pool.Close()
		}
		lastErr = err
		select {
		case <-time.After(2 * time.Second):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return nil, fmt.Errorf("postgres unavailable: %w", lastErr)
}
