/**
 * Tracing
 *
 * OpenInference span helpers over the global OpenTelemetry API. Spans are
 * no-ops until a tracer provider is registered (see ../telemetry/weave.ts), so
 * the core carries no exporter and no vendor.
 *
 * `withSpanKind` is the single primitive every traced seam builds on: AGENT
 * for a run, LLM for a model call, TOOL for a tool call, GUARDRAIL for an
 * injection screen.
 *
 * Ported from Solenoid-Assistant src/core/tracing/.
 */
import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from '@arizeai/openinference-semantic-conventions';
import { type Attributes, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import type { ChatMessage, ChatOptions } from './providers.js';

export type SpanKind = keyof typeof OpenInferenceSpanKind;
export type { Attributes, Span };
export { SemanticConventions, SpanStatusCode };

const tracer = () => trace.getTracer('solenoid');

// Reasoning traces can run to thousands of tokens; enough to diagnose a turn
// is enough to store.
const MAX_REASONING_CHARS = 2000;

export function safeJson(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(value, null, indent) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Serialize a transcript for tracing without provider-native payloads. */
export function safeMessagesJson(messages: ChatMessage[]): string {
  return safeJson(messages.map(({ raw: _raw, ...message }) => message));
}

/**
 * Run `fn` inside an active span of the given OpenInference kind. The span is
 * the active context, so nested spans attach to it. Errors are recorded and
 * rethrown.
 *
 * `attributes` is a function so that serializing a transcript is skipped
 * entirely while no tracer provider is registered, which is the default.
 */
export function withSpanKind<T>(
  kind: SpanKind,
  name: string,
  attributes: () => Attributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    { attributes: { [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind[kind] } },
    async (span) => {
      if (span.isRecording()) span.setAttributes(attributes());
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

function messageAttributes(prefix: string, m: ChatMessage): Attributes {
  const attrs: Attributes = {
    [`${prefix}.${SemanticConventions.MESSAGE_ROLE}`]: m.role,
    [`${prefix}.${SemanticConventions.MESSAGE_CONTENT}`]: m.content,
  };
  // Without this, a turn that spends all its tokens on reasoning shows up as
  // empty output with a non-zero token count and no explanation.
  if (m.thinking) {
    attrs[`${prefix}.message.reasoning`] =
      m.thinking.length > MAX_REASONING_CHARS
        ? `${m.thinking.slice(0, MAX_REASONING_CHARS)}… [truncated ${m.thinking.length - MAX_REASONING_CHARS} chars]`
        : m.thinking;
  }
  if (m.finishReason) attrs[`${prefix}.message.finish_reason`] = m.finishReason;
  m.toolCalls?.forEach((call, j) => {
    const t = `${prefix}.${SemanticConventions.MESSAGE_TOOL_CALLS}.${j}`;
    attrs[`${t}.${SemanticConventions.TOOL_CALL_ID}`] = call.id;
    attrs[`${t}.${SemanticConventions.TOOL_CALL_FUNCTION_NAME}`] = call.name;
    attrs[`${t}.${SemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`] = safeJson(
      call.arguments
    );
  });
  return attrs;
}

/** One LLM span around one provider call. */
export function tracedChat(
  providerName: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  inner: () => Promise<ChatMessage>
): Promise<ChatMessage> {
  const attributes = (): Attributes => {
    const attrs: Attributes = {
      [SemanticConventions.LLM_MODEL_NAME]: opts.model,
      [SemanticConventions.LLM_PROVIDER]: providerName,
      [SemanticConventions.LLM_INVOCATION_PARAMETERS]: safeJson({
        think: opts.think,
        turn: opts.turn,
      }),
      [SemanticConventions.INPUT_VALUE]: safeMessagesJson(messages),
      [SemanticConventions.INPUT_MIME_TYPE]: 'application/json',
    };
    messages.forEach((m, i) => {
      Object.assign(attrs, messageAttributes(`${SemanticConventions.LLM_INPUT_MESSAGES}.${i}`, m));
    });
    opts.tools.forEach((tool, i) => {
      attrs[`${SemanticConventions.LLM_TOOLS}.${i}.tool.json_schema`] = safeJson(tool);
    });
    return attrs;
  };

  return withSpanKind('LLM', `chat ${opts.model}`, attributes, async (span) => {
    const msg = await inner();
    if (!span.isRecording()) return msg;
    span.setAttributes({
      ...messageAttributes(`${SemanticConventions.LLM_OUTPUT_MESSAGES}.0`, msg),
      [SemanticConventions.OUTPUT_VALUE]: msg.content,
      ...(msg.usage?.promptTokens != null
        ? { [SemanticConventions.LLM_TOKEN_COUNT_PROMPT]: msg.usage.promptTokens }
        : {}),
      ...(msg.usage?.completionTokens != null
        ? { [SemanticConventions.LLM_TOKEN_COUNT_COMPLETION]: msg.usage.completionTokens }
        : {}),
      ...(msg.usage?.totalTokens != null
        ? { [SemanticConventions.LLM_TOKEN_COUNT_TOTAL]: msg.usage.totalTokens }
        : {}),
    });
    return msg;
  });
}
