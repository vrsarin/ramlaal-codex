// Package telemetry exports traces and logs over OTLP so one backend shows how a request moved
// through this instance and across instances. It is a no-op until OTEL_EXPORTER_OTLP_ENDPOINT is set.
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"os"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Setup installs the global tracer, propagator and slog default (which also captures the std log
// package). The returned function flushes and must be called on shutdown.
func Setup(ctx context.Context, service, instance string) func(context.Context) error {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
		return func(context.Context) error { return nil }
	}

	attrs := []attribute.KeyValue{attribute.String("service.name", service)}
	if instance != "" {
		attrs = append(attrs, attribute.String("service.instance.id", instance), attribute.String("ramlaal.instance", instance))
	}
	res, err := resource.New(ctx, resource.WithFromEnv(), resource.WithAttributes(attrs...))
	if err != nil {
		slog.Warn("telemetry: resource", "err", err)
		res = resource.Default()
	}

	te, err := otlptracehttp.New(ctx)
	if err != nil {
		slog.Warn("telemetry: trace exporter", "err", err)
		return func(context.Context) error { return nil }
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(te), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)

	shutdown := tp.Shutdown
	if le, err := otlploghttp.New(ctx); err != nil {
		slog.Warn("telemetry: log exporter", "err", err)
	} else {
		lp := sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewBatchProcessor(le)), sdklog.WithResource(res))
		slog.SetDefault(slog.New(tee{slog.NewTextHandler(os.Stderr, nil), otelslog.NewHandler(service, otelslog.WithLoggerProvider(lp))}))
		shutdown = func(c context.Context) error { return errors.Join(tp.Shutdown(c), lp.Shutdown(c)) }
	}
	return shutdown
}

// tee writes each record to stderr and to OTLP; the OTLP handler stamps trace_id/span_id from ctx.
type tee [2]slog.Handler

func (t tee) Enabled(ctx context.Context, l slog.Level) bool {
	return t[0].Enabled(ctx, l) || t[1].Enabled(ctx, l)
}

func (t tee) Handle(ctx context.Context, r slog.Record) error {
	var err error
	for _, h := range t {
		if h.Enabled(ctx, r.Level) {
			err = errors.Join(err, h.Handle(ctx, r.Clone()))
		}
	}
	return err
}

func (t tee) WithAttrs(a []slog.Attr) slog.Handler { return tee{t[0].WithAttrs(a), t[1].WithAttrs(a)} }
func (t tee) WithGroup(n string) slog.Handler      { return tee{t[0].WithGroup(n), t[1].WithGroup(n)} }
