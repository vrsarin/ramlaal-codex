import { context, propagation, SpanKind, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// Traces and logs go over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise everything is a no-op.
const enabled = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const SERVICE = process.env.OTEL_SERVICE_NAME ?? "gateway";
let logger: Logger | undefined;
let tracerProvider: NodeTracerProvider | undefined;
let loggerProvider: LoggerProvider | undefined;

if (enabled) {
  const resource = resourceFromAttributes({ "service.name": SERVICE });
  tracerProvider = new NodeTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] });
  tracerProvider.register(); // installs the W3C trace-context propagator and async context manager
  loggerProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor(new OTLPLogExporter())] });
  logger = loggerProvider.getLogger(SERVICE);
}

const tracer = trace.getTracer(SERVICE);

/** Runs fn inside a server span that continues the caller's trace (traceparent header). */
export async function inRequestSpan<T>(headers: Record<string, string | string[] | undefined>, name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  const parent = propagation.extract(context.active(), headers, {
    get: (h, k) => {
      const v = h[k];
      return Array.isArray(v) ? v[0] : v;
    },
    keys: (h) => Object.keys(h),
  });
  return tracer.startActiveSpan(name, { kind: SpanKind.SERVER }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Environment for a child process so it can continue the current trace (TRACEPARENT). */
export function traceEnv(ctx: Context = context.active()): NodeJS.ProcessEnv {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier.traceparent ? { TRACEPARENT: carrier.traceparent, ...(carrier.tracestate ? { TRACESTATE: carrier.tracestate } : {}) } : {};
}

const levels = { info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR } as const;

/** Console log that is also exported with the active trace/span ids, so logs sit next to their trace. */
export function log(level: keyof typeof levels, body: string, attributes: Record<string, string | number | boolean> = {}): void {
  console[level === "info" ? "log" : level](body, Object.keys(attributes).length ? attributes : "");
  logger?.emit({ severityNumber: levels[level], severityText: level.toUpperCase(), body, attributes, context: context.active() });
}

export async function shutdownTelemetry(): Promise<void> {
  await Promise.allSettled([tracerProvider?.shutdown(), loggerProvider?.shutdown()]);
}
