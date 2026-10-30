package main

import (
	"context"
	"hash/fnv"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// hashEmbedder gives each word a fixed axis, so texts sharing words are close.
type hashEmbedder struct{ dims int }

func (h hashEmbedder) Embed(_ context.Context, text string) ([]float32, error) {
	v := make([]float32, h.dims)
	for _, w := range strings.Fields(strings.ToLower(text)) {
		f := fnv.New32a()
		f.Write([]byte(w))
		v[int(f.Sum32())%h.dims]++
	}
	return v, nil
}

// Runs only with PG_TEST_DSN set, e.g. postgres://postgres:example@127.0.0.1:5432/postgres
func TestPgStoreRoundTrip(t *testing.T) {
	dsn := os.Getenv("PG_TEST_DSN")
	if dsn == "" {
		t.Skip("PG_TEST_DSN not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	const dims = 64
	if err := Migrate(ctx, pool, dims); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool, dims); err != nil { // idempotent
		t.Fatal(err)
	}
	user := "test-" + t.Name()
	defer pool.Exec(ctx, "DELETE FROM memories WHERE user_id = $1", user)
	s := NewPgStore(pool, hashEmbedder{dims}, user)

	var wg sync.WaitGroup
	for _, txt := range []string{"fix the pagination off-by-one error", "rotate the api credentials", "tune the postgres vacuum"} {
		wg.Add(1)
		go func(txt string) { // concurrent writers
			defer wg.Done()
			if _, err := s.Add(ctx, txt, map[string]any{"kind": "lesson"}); err != nil {
				t.Error(err)
			}
		}(txt)
	}
	wg.Wait()

	hits, err := s.Search(ctx, "pagination error", 2)
	if err != nil || len(hits) != 2 {
		t.Fatalf("hits=%v err=%v", hits, err)
	}
	if hits[0].Text != "fix the pagination off-by-one error" || hits[0].Metadata["kind"] != "lesson" || hits[0].ID == "" {
		t.Fatalf("unexpected top hit: %+v", hits[0])
	}

	other := NewPgStore(pool, hashEmbedder{dims}, user+"-other")
	if hits, _ := other.Search(ctx, "pagination", 5); len(hits) != 0 {
		t.Fatalf("other user must not see memories: %v", hits)
	}
}
