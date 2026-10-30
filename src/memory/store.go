package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultUserID is the single memory owner until per-user identity is added.
const DefaultUserID = "ramlaal"

type Hit struct {
	ID       string         `json:"id"`
	Text     string         `json:"text"`
	Score    float64        `json:"score"`
	Metadata map[string]any `json:"metadata"`
}

// Store is the memory backend. No custom ranking: results are plain vector similarity.
type Store interface {
	Add(ctx context.Context, text string, metadata map[string]any) (string, error)
	Search(ctx context.Context, query string, limit int) ([]Hit, error)
}

// PgStore keeps memories in Postgres/pgvector. All state lives in the database, so any number
// of replicas can serve the same memory.
type PgStore struct {
	pool   *pgxpool.Pool
	embed  Embedder
	userID string
}

func NewPgStore(pool *pgxpool.Pool, embed Embedder, userID string) *PgStore {
	return &PgStore{pool: pool, embed: embed, userID: userID}
}

// Migrate creates the schema. The advisory lock makes concurrent replica starts safe.
func Migrate(ctx context.Context, pool *pgxpool.Pool, dims int) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(727274)"); err != nil {
		return err
	}
	stmts := []string{
		"CREATE EXTENSION IF NOT EXISTS vector",
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS memories (
			id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id    text NOT NULL,
			content    text NOT NULL,
			metadata   jsonb NOT NULL DEFAULT '{}',
			embedding  vector(%d) NOT NULL,
			created_at timestamptz NOT NULL DEFAULT now()
		)`, dims),
		"CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id)",
		"CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops)",
	}
	for _, s := range stmts {
		if _, err := tx.Exec(ctx, s); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	return tx.Commit(ctx)
}

func (s *PgStore) Add(ctx context.Context, text string, metadata map[string]any) (string, error) {
	vec, err := s.embed.Embed(ctx, text)
	if err != nil {
		return "", err
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	meta, err := json.Marshal(metadata)
	if err != nil {
		return "", err
	}
	var id string
	err = s.pool.QueryRow(ctx,
		`INSERT INTO memories (user_id, content, metadata, embedding)
		 VALUES ($1, $2, $3::jsonb, $4::vector) RETURNING id::text`,
		s.userID, text, string(meta), vectorLiteral(vec)).Scan(&id)
	return id, err
}

func (s *PgStore) Search(ctx context.Context, query string, limit int) ([]Hit, error) {
	vec, err := s.embed.Embed(ctx, query)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id::text, content, metadata, 1 - (embedding <=> $1::vector) AS score
		 FROM memories WHERE user_id = $2
		 ORDER BY embedding <=> $1::vector LIMIT $3`,
		vectorLiteral(vec), s.userID, limit)
	if err != nil {
		return nil, err
	}
	hits, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Hit, error) {
		var h Hit
		var meta []byte
		if err := r.Scan(&h.ID, &h.Text, &meta, &h.Score); err != nil {
			return h, err
		}
		if err := json.Unmarshal(meta, &h.Metadata); err != nil || h.Metadata == nil {
			h.Metadata = map[string]any{}
		}
		return h, nil
	})
	if hits == nil {
		hits = []Hit{}
	}
	return hits, err
}
