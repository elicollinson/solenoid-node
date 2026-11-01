import type { TextOrigin } from '@elicollinson/solenoid-security';
/**
 * Chat Providers
 *
 * One normalized chat interface for the agent loop, and one implementation of
 * it: OpenAI-compatible Chat Completions. That covers both supported backends,
 * LM Studio (local, `/v1`) and OpenRouter, which differ only in how they spell
 * reasoning on the wire.
 *
 * Every call streams, even though `chat()` resolves to one finished message.
 * Streaming is what lets the UI draw text as it arrives (`onDelta`) and what
 * lets an AbortSignal actually stop server-side generation.
 *
 * Ported from Solenoid-Assistant src/core/providers.ts. The Ollama and
 * Anthropic adapters were left behind; the message shape was kept so the two
 * repos can converge on one core later.
 */
import type OpenAI from 'openai';
import { ProviderStalledError } from './errors.js';
import { abortReason } from './signals.js';
import type { FunctionToolDefinition } from './tools.js';
import { tracedChat } from './tracing.js';

export type ThinkLevel = boolean | 'low' | 'medium' | 'high';

export interface ToolCall {
  id: string;
  name: string;
  /**
   * Parsed object when valid. Malformed provider JSON is preserved as the raw
   * string so the tool boundary can return repair feedback on the next turn.
   */
  arguments: unknown;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * Who wrote this, for the injection screen. Absent means `external`, the
   * safe default. Set `operator` only where a person is typing to their own
   * agent. Transport ignores it: it never reaches a provider API.
   */
  origin?: TextOrigin;
  /**
   * Set by the agent loop on every message it produced or already screened
   * (assistant turns, tool results). A conversation replays its transcript on
   * every turn; without this mark the whole history would be re-screened each
   * time, which costs a judge call per turn and, because the screen joins text
   * of one origin before it looks, can flag a long run of individually clean
   * turns on the concatenation alone.
   */
  screened?: boolean;
  thinking?: string;
  toolCalls?: ToolCall[]; // assistant messages only
  toolCallId?: string; // tool messages only
  toolName?: string; // tool messages only
  /**
   * Provider-native assistant payload, echoed back verbatim on later turns.
   * OpenRouter needs its `reasoning_details` resent to continue a reasoning
   * model across tool calls. Never edit this.
   */
  raw?: unknown;
  usage?: TokenUsage;
  /** Provider stop signal, normalized without discarding the native value. */
  finishReason?: string;
}

/** A streamed fragment of the turn in progress. */
export interface ChatDelta {
  type: 'text' | 'reasoning';
  text: string;
}

export interface ChatOptions {
  model: string;
  tools: FunctionToolDefinition[];
  think?: ThinkLevel;
  signal?: AbortSignal;
  turn?: number;
  /** Called for every text or reasoning fragment as it arrives. */
  onDelta?: (delta: ChatDelta) => void;
}

export interface ChatProvider {
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage>;
  /** Backend label surfaced on LLM spans as llm.provider. */
  readonly providerName: string;
}

export interface ModelRoute {
  client: ChatProvider;
  model: string;
}

/** Ordered route chain with its non-empty invariant represented in the type. */
export type ModelRouteChain = readonly [ModelRoute, ...ModelRoute[]];

/**
 * How a backend spells reasoning.
 * - `lmstudio`: `reasoning_effort` on the request, `reasoning_content` on the
 *   response.
 * - `openrouter`: a `reasoning` object on the request, `reasoning` plus
 *   `reasoning_details` on the response.
 */
export type ReasoningDialect = 'lmstudio' | 'openrouter';

interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}

type DeltaWithReasoning = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
  reasoning?: string | null;
  reasoning_details?: unknown[];
};

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return raw;
  }
}

export class OpenAICompatibleProvider implements ChatProvider {
  /**
   * @param providerName The backend, which also fixes how reasoning is spelled
   *   on the wire. Shown in logs and traces.
   */
  constructor(
    private readonly client: OpenAI,
    readonly providerName: ReasoningDialect
  ) {}

  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    return tracedChat(this.providerName, messages, opts, () =>
      this.chatInner(messages, opts).catch((error: unknown) => {
        throw stallOf(error) ?? error;
      })
    );
  }

  private async chatInner(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const wire = messages.map((m) => this.toWire(m));
    const stream = await this.client.chat.completions.create(
      {
        model: opts.model,
        messages: wire,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.tools.length
          ? { tools: opts.tools as OpenAI.Chat.Completions.ChatCompletionTool[] }
          : {}),
        ...this.reasoningParams(opts.think),
      },
      { signal: opts.signal }
    );

    let content = '';
    let thinking = '';
    let finishReason: string | undefined;
    let usage: TokenUsage | undefined;
    const reasoningDetails: unknown[] = [];
    const calls = new Map<number, StreamedToolCall>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        const details = chunk.usage.completion_tokens_details;
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
          ...(details?.reasoning_tokens != null
            ? { reasoningTokens: details.reasoning_tokens }
            : {}),
        };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta as DeltaWithReasoning | undefined;
      if (!delta) continue;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) {
        thinking += reasoning;
        opts.onDelta?.({ type: 'reasoning', text: reasoning });
      }
      if (delta.reasoning_details?.length) reasoningDetails.push(...delta.reasoning_details);
      if (delta.content) {
        content += delta.content;
        opts.onDelta?.({ type: 'text', text: delta.content });
      }
      for (const part of delta.tool_calls ?? []) {
        const existing = calls.get(part.index);
        if (existing) {
          existing.arguments += part.function?.arguments ?? '';
          if (part.function?.name) existing.name += part.function.name;
        } else {
          calls.set(part.index, {
            id: part.id ?? `call_${part.index}`,
            name: part.function?.name ?? '',
            arguments: part.function?.arguments ?? '',
          });
        }
      }
    }
    if (opts.signal?.aborted) throw abortReason(opts.signal);

    const streamed = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    // Rebuilt rather than taken off the wire: a stream has no single message
    // object, so this is the assistant turn as the API would have returned it.
    const raw: Record<string, unknown> = {
      role: 'assistant',
      content: content || null,
      ...(streamed.length
        ? {
            tool_calls: streamed.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
      ...(reasoningDetails.length
        ? { reasoning_details: mergeReasoningDetails(reasoningDetails) }
        : {}),
    };

    return {
      role: 'assistant',
      content,
      ...(thinking ? { thinking } : {}),
      ...(streamed.length
        ? {
            toolCalls: streamed.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: parseToolArguments(call.arguments),
            })),
          }
        : {}),
      raw,
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
    };
  }

  private reasoningParams(think: ThinkLevel | undefined): Record<string, unknown> {
    if (think === undefined || think === true) return {};
    if (this.providerName === 'openrouter') {
      return think === false ? { reasoning: { enabled: false } } : { reasoning: { effort: think } };
    }
    // LM Studio reads `none` as "reasoning off".
    return { reasoning_effort: think === false ? 'none' : think };
  }

  private toWire(m: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    if (m.role === 'assistant' && m.raw) {
      return m.raw as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
    }
    return { role: m.role, content: m.content };
  }
}

/**
 * OpenRouter streams `reasoning_details` as many fragments sharing an index.
 * Resending hundreds of one-word fragments works but bloats every later
 * request, so fragments of the same index and type are joined back into one.
 */
function mergeReasoningDetails(details: unknown[]): unknown[] {
  const merged: Record<string, unknown>[] = [];
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    const next = detail as Record<string, unknown>;
    const last = merged[merged.length - 1];
    if (
      last &&
      last.index === next.index &&
      last.type === next.type &&
      typeof last.text === 'string' &&
      typeof next.text === 'string'
    ) {
      last.text += next.text;
      continue;
    }
    merged.push({ ...next });
  }
  return merged;
}

/** The stall behind `error`: the SDK reports one before the response as a connection error. */
function stallOf(error: unknown): ProviderStalledError | undefined {
  if (error instanceof ProviderStalledError) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof ProviderStalledError ? cause : undefined;
}

/** Whether a failed provider call is worth retrying: rate limits, 5xx, dropped connections. */
export function isTransientProviderError(error: unknown): boolean {
  // A server that went quiet once will likely do so again; the next route is the better bet.
  if (stallOf(error)) return false;
  const candidate = error as {
    status?: number;
    statusCode?: number;
    code?: string;
    name?: string;
    message?: string;
    cause?: { code?: string };
  } | null;
  const status = candidate?.status ?? candidate?.statusCode;
  if (status === 408 || status === 409 || status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const code = candidate?.code ?? candidate?.cause?.code ?? '';
  return (
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(
      code
    ) ||
    ['TimeoutError', 'APIConnectionError', 'APIConnectionTimeoutError'].includes(
      candidate?.name ?? ''
    ) ||
    // undici: "fetch failed" before a response, "terminated" when the server
    // drops a stream part-way through.
    (candidate?.name === 'TypeError' &&
      (candidate?.message?.includes('fetch failed') === true ||
        candidate?.message === 'terminated'))
  );
}
