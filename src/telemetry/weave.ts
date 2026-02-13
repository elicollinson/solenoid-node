/**
 * Weights & Biases Weave Tracing via OpenTelemetry
 *
 * Opt-in tracing: enabled only when WANDB_API_KEY and WANDB_PROJECT_ID are set.
 * Uses ADK's maybeSetOtelProviders() to wire a BatchSpanProcessor + OTLP
 * protobuf exporter targeting Weave's trace endpoint. ADK automatically
 * instruments agent invocations, tool calls, LLM requests, and agent transfers.
 */
import { maybeSetOtelProviders } from '@google/adk';
import type { Context } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { uiLogger } from '../utils/logger.js';

/**
 * Sanitize a span name for Weave compatibility.
 * Weave rejects object names with special characters like brackets and colons.
 * Replace anything that isn't alphanumeric, underscore, hyphen, space, or dot.
 */
function sanitizeSpanName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
}

/**
 * Wraps a SpanProcessor to sanitize span names for Weave compatibility.
 */
class WeaveSpanProcessor implements SpanProcessor {
  constructor(private delegate: BatchSpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    const sanitized = sanitizeSpanName(span.name);
    if (sanitized !== span.name) {
      span.updateName(sanitized);
    }
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

let processor: WeaveSpanProcessor | null = null;

export function initTracing(): void {
  const apiKey = process.env.WANDB_API_KEY;
  const projectId = process.env.WANDB_PROJECT_ID;
  const baseUrl = process.env.WANDB_BASE_URL ?? 'https://trace.wandb.ai';

  if (!apiKey || !projectId) {
    uiLogger.debug('Weave tracing disabled (WANDB_API_KEY or WANDB_PROJECT_ID not set)');
    return;
  }

  const url = `${baseUrl}/otel/v1/traces`;
  const auth = Buffer.from(`api:${apiKey}`).toString('base64');

  const exporter = new OTLPTraceExporter({
    url,
    headers: {
      Authorization: `Basic ${auth}`,
      project_id: projectId,
    },
  });

  processor = new WeaveSpanProcessor(new BatchSpanProcessor(exporter));

  // ADK's maybeSetOtelProviders registers a global NodeTracerProvider
  // with the given span processors. ADK's tracer proxy resolves it lazily.
  maybeSetOtelProviders([{ spanProcessors: [processor] }]);

  uiLogger.info({ projectId, url }, 'Weave tracing enabled');
}

export async function shutdownTracing(): Promise<void> {
  if (!processor) return;
  try {
    await processor.forceFlush();
    await processor.shutdown();
  } catch (error) {
    uiLogger.warn({ error: String(error) }, 'Error shutting down tracing');
  }
}
