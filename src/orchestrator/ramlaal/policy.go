package ramlaal

import (
	"context"
	"fmt"
	"strings"
)

// safeChoice is what to do when the decider errors or is not confident enough: the safe, more expensive path.
var safeChoice = map[string]string{"route": "strong", "after_failure": "retry", "review": "required"}

// Policy is where a decider's typed answers steer the workflow:
//   - route:         pick a model tier (cheap first, strong when the task looks hard or the decider is unsure)
//   - after_failure: retry, or escalate to a human right away when the problem is not fixable by code
//   - review:        optionally skip the independent review once an objective check passed (off by default;
//     skipped work is never admitted to long-term memory)
//   - tuning:        outcomes of past routing decisions decide whether the cheap tier is earning its keep
type Policy struct {
	Decider              Decider
	Prices               *PriceBook
	CheapModel           string
	StrongModel          string
	ReviewerModel        string // defaults to the strong model
	RouteConfidence      float64
	EscalateConfidence   float64
	SkipReviewConfidence *float64
	TuneMinSamples       int
	TuneMinRate          float64
	ProbeEvery           int
}

func NewPolicy() *Policy {
	return &Policy{
		Decider:            RuleDecider{},
		Prices:             NewPriceBook(nil),
		RouteConfidence:    0.7,
		EscalateConfidence: 0.8,
		TuneMinSamples:     5,
		TuneMinRate:        0.6,
		ProbeEvery:         5,
	}
}

func (p *Policy) ModelFor(tier string) string {
	if tier == "cheap" {
		return p.CheapModel
	}
	return p.StrongModel
}

func (p *Policy) ReviewModel() string {
	if p.ReviewerModel != "" {
		return p.ReviewerModel
	}
	return p.StrongModel
}

func (p *Policy) ask(ctx context.Context, l *Ledger, taskID int64, name string, options []string, detail string) Decision {
	d, err := p.Decider.Decide(ctx, name, options, detail)
	if err == nil && !contains(options, d.Choice) {
		err = fmt.Errorf("invalid choice %q", d.Choice)
	}
	if err != nil {
		d = Decision{Choice: safeChoice[name], Source: "default", FallbackFrom: typeName(err)}
	}
	l.Append("decision", &taskID, "policy", map[string]any{
		"name": name, "choice": d.Choice, "confidence": d.Confidence, "source": d.Source,
		"cost_usd": d.CostUSD, "fallback_from": nilIfEmpty(d.FallbackFrom),
	})
	if d.CostUSD != 0 {
		l.AddCost(taskID, d.CostUSD)
	}
	return d
}

// Charge records token cost for one peer run.
func (p *Policy) Charge(l *Ledger, taskID int64, role, model string, u Usage) {
	if u.Total() == 0 {
		return
	}
	usd := p.Prices.Cost(model, u)
	l.Append("cost", &taskID, role, map[string]any{
		"model": nilIfEmpty(model), "input_tokens": u.InputTokens,
		"cached_input_tokens": u.CachedInputTokens, "output_tokens": u.OutputTokens, "cost_usd": usd,
	})
	l.AddCost(taskID, usd)
}

func (p *Policy) Route(ctx context.Context, l *Ledger, taskID int64, mission string) string {
	d := p.ask(ctx, l, taskID, "route", []string{"cheap", "strong"}, mission)
	tier := d.Choice
	if tier == "cheap" && d.Confidence < p.RouteConfidence {
		tier = "strong"
	}
	if tier == "cheap" && !p.cheapViable(l) {
		tier = "strong"
		l.Append("route_overridden", &taskID, "policy", map[string]any{"reason": "cheap tier underperforming recently"})
	}
	return tier
}

func (p *Policy) ShouldEscalate(ctx context.Context, l *Ledger, taskID int64, problem string) bool {
	d := p.ask(ctx, l, taskID, "after_failure", []string{"retry", "escalate"}, problem)
	return d.Choice == "escalate" && d.Confidence >= p.EscalateConfidence
}

func (p *Policy) CanSkipReview(ctx context.Context, l *Ledger, taskID int64, mission, verifyOutput string) bool {
	if p.SkipReviewConfidence == nil {
		return false
	}
	d := p.ask(ctx, l, taskID, "review", []string{"required", "skip"},
		fmt.Sprintf("Mission: %s\nAn objective verification command passed:\n%s", mission, tail(verifyOutput, 800)))
	return d.Choice == "skip" && d.Confidence >= *p.SkipReviewConfidence
}

func (p *Policy) RecordOutcome(l *Ledger, taskID int64, tier, status string, attempts int) {
	l.Append("route_outcome", &taskID, "policy", map[string]any{
		"tier": tier, "status": status, "attempts": attempts,
		"first_try_ok": status == "completed" && attempts == 1,
	})
}

func (p *Policy) cheapViable(l *Ledger) bool {
	history := l.Recent("route_outcome", 50)
	cheap, firstCheap, ok := 0, 0, 0
	for i, e := range history {
		if e.Payload["tier"] != "cheap" {
			continue
		}
		if cheap == 0 {
			firstCheap = i
		}
		cheap++
		if v, _ := e.Payload["first_try_ok"].(bool); v {
			ok++
		}
	}
	if cheap < p.TuneMinSamples {
		return true
	}
	if float64(ok)/float64(cheap) >= p.TuneMinRate {
		return true
	}
	// re-probe the cheap tier now and then so it can win its place back
	return firstCheap >= p.ProbeEvery
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// PolicyFromEnv builds the cost policy from DECIDER, MODEL_CHEAP, MODEL_STRONG, MODEL_REVIEWER,
// MODEL_PRICES and SKIP_REVIEW_CONFIDENCE.
func PolicyFromEnv(env map[string]string) (*Policy, error) {
	if env == nil {
		env = osEnvMap()
	}
	prices := NewPriceBook(nil)
	if raw := env["MODEL_PRICES"]; raw != "" {
		pb, err := priceBookFromJSON(raw)
		if err != nil {
			return nil, fmt.Errorf("MODEL_PRICES: %w", err)
		}
		prices = pb
	}
	decider, err := BuildDecider(env, prices)
	if err != nil {
		return nil, err
	}
	p := NewPolicy()
	p.Decider, p.Prices = decider, prices
	p.CheapModel, p.StrongModel, p.ReviewerModel = env["MODEL_CHEAP"], env["MODEL_STRONG"], env["MODEL_REVIEWER"]
	if raw := strings.TrimSpace(env["SKIP_REVIEW_CONFIDENCE"]); raw != "" {
		f, ok := toFloat(raw)
		if !ok {
			return nil, fmt.Errorf("SKIP_REVIEW_CONFIDENCE: not a number: %q", raw)
		}
		p.SkipReviewConfidence = &f
	}
	return p, nil
}
