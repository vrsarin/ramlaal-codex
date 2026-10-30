package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Embedder turns text into a fixed-size vector.
type Embedder interface {
	Embed(ctx context.Context, text string) ([]float32, error)
}

// OllamaEmbedder calls Ollama's /api/embed. A semaphore bounds in-flight calls so a burst of
// agents cannot overload the embedding server.
type OllamaEmbedder struct {
	baseURL string
	model   string
	dims    int
	http    *http.Client
	sem     chan struct{}
}

func NewOllamaEmbedder(baseURL, model string, dims, maxInflight int) *OllamaEmbedder {
	if maxInflight < 1 {
		maxInflight = 1
	}
	return &OllamaEmbedder{
		baseURL: strings.TrimRight(baseURL, "/"),
		model:   model,
		dims:    dims,
		http:    &http.Client{Timeout: 60 * time.Second},
		sem:     make(chan struct{}, maxInflight),
	}
}

func (e *OllamaEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	select {
	case e.sem <- struct{}{}:
		defer func() { <-e.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	body, _ := json.Marshal(map[string]any{"model": e.model, "input": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.baseURL+"/api/embed", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := e.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embedder unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("embedder returned %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	var out struct {
		Embeddings [][]float32 `json:"embeddings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("embedder response: %w", err)
	}
	if len(out.Embeddings) != 1 {
		return nil, fmt.Errorf("embedder returned %d embeddings, want 1", len(out.Embeddings))
	}
	if v := out.Embeddings[0]; len(v) != e.dims {
		return nil, fmt.Errorf("embedding has %d dimensions, EMBED_DIMS is %d", len(v), e.dims)
	}
	return out.Embeddings[0], nil
}

// vectorLiteral renders a pgvector text literal such as "[0.1,0.2]".
func vectorLiteral(v []float32) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(f), 'g', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}
