package ramlaal

import "encoding/json"

// Usage is token usage for one model call or run.
type Usage struct {
	InputTokens       int
	CachedInputTokens int
	OutputTokens      int
}

func (u Usage) Total() int { return u.InputTokens + u.OutputTokens }

// ModelPrice is USD per million tokens.
type ModelPrice struct {
	Input       float64  `json:"input"`
	CachedInput *float64 `json:"cached_input"`
	Output      float64  `json:"output"`
}

// PriceBook maps a model name to its price; unknown models cost 0.
type PriceBook struct {
	prices map[string]ModelPrice
}

func NewPriceBook(prices map[string]ModelPrice) *PriceBook {
	return &PriceBook{prices: prices}
}

// priceBookFromJSON parses {"model": {"input": 1.0, "cached_input": 0.1, "output": 4.0}}.
func priceBookFromJSON(raw string) (*PriceBook, error) {
	var prices map[string]ModelPrice
	if err := json.Unmarshal([]byte(raw), &prices); err != nil {
		return nil, err
	}
	return NewPriceBook(prices), nil
}

func (pb *PriceBook) Cost(model string, u Usage) float64 {
	if pb == nil {
		return 0
	}
	key := model
	if key == "" {
		key = "default"
	}
	p, ok := pb.prices[key]
	if !ok {
		return 0
	}
	fresh := u.InputTokens - u.CachedInputTokens
	if fresh < 0 {
		fresh = 0
	}
	cachedRate := p.Input
	if p.CachedInput != nil {
		cachedRate = *p.CachedInput
	}
	return (float64(fresh)*p.Input + float64(u.CachedInputTokens)*cachedRate + float64(u.OutputTokens)*p.Output) / 1_000_000
}
