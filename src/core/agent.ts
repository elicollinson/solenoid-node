/**
 * Agent
 *
 * A framework-free agent loop: call the model, run the tools it asks for,
 * feed the results back, repeat until it answers. Around that loop:
 *
 * - Model routes: an ordered fallback chain. Each route gets a fresh deadline
 *   and replays the task from its original input.
 * - Transient provider errors back off and retry; truncated or empty turns
 *   are continued; a refusal fails the attempt.
 * - Optional structured output: a zod schema becomes a `submit_result` tool,
 *   validated with repair feedback.
 * - Cancellation: one AbortSignal reaches every model call, tool call and wait.
 * - Approvals: a write tool runs only after the run's approval handler allows it.
 * - Injection screening at every boundary, through solenoid-security.
 * - Streaming: every delta, turn, tool call and retry is reported as an
 *   `AgentEvent` while the run is in progress.
 *
 * Ported from Solenoid-Assistant src/core/rawAgent.ts. Differences: the loop
 * streams events; nothing is read from the environment (screening, logging
 * and approvals are all injected); tool groups and the two-stage structured
 * strategy were left behind; a run returns its transcript so a caller can
 * hold a multi-turn conversation.
 */
import {
  type ScreeningResult,
  type TextInput,
  type TextOrigin,
  type ToolVerdict,
  currentToolGate,
} from '@elicollinson/solenoid-security';
import type { z } from 'zod/v4';
import type { ChatMessage, ChatProvider, ThinkLevel, TokenUsage } from './providers.js';
import type { ReviewResult, Reviewer } from './reviewer.js';
import {
  type AgentTool,
  type FunctionToolDefinition,
  type ToolKind,
  toJsonSchema,
} from './tools.js';
import {
  SemanticConventions,
  SpanStatusCode,
  safeJson,
  safeMessagesJson,
  withSpanKind,
} from './tracing.js';

export const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60_000;
const SUBMIT_RESULT_TOOL_NAME = 'submit_result';
/** Consecutive transient failures of one model call before the attempt fails. */
const MAX_TRANSIENT_RETRIES = 4;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AgentTimeoutError extends Error {
  readonly code = 'AGENT_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(`Agent run timed out after ${timeoutMs}ms`);
    this.name = 'AgentTimeoutError';
  }
}

/** The caller's signal fired. Never retried, never advanced to another route. */
export class AgentAbortedError extends Error {
  readonly code = 'AGENT_ABORTED';

  constructor() {
    super('Agent run was interrupted');
    this.name = 'AgentAbortedError';
  }
}

export class AgentRunError extends Error {
  readonly code = 'AGENT_RUN_FAILED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentRunError';
  }
}

export type ScreeningBoundary = 'input' | 'tool_output' | 'model_output' | 'reviewer_output';

export class PromptInjectionDetectedError extends Error {
  readonly code = 'PROMPT_INJECTION_DETECTED';

  constructor(readonly boundary: ScreeningBoundary) {
    super(`Prompt injection detected at ${boundary} boundary`);
    this.name = 'PromptInjectionDetectedError';
  }
}

/** The screen could not reach a verdict. Fails closed: the run stops. */
export class PromptInjectionScreeningError extends Error {
  readonly code = 'PROMPT_INJECTION_SCREENING_FAILED';

  constructor(options?: ErrorOptions) {
    super('Prompt injection screening failed', options);
    this.name = 'PromptInjectionScreeningError';
  }
}

function isScreeningFailure(error: unknown): boolean {
  return (
    error instanceof PromptInjectionDetectedError || error instanceof PromptInjectionScreeningError
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * What one tool call came back with, and whether it worked.
 *
 * `ok` is carried rather than inferred from the wording: an MCP server can
 * relay a remote message starting "Error: " verbatim, and a caller re-reading
 * prose would record a successful call as a failure. `output` is what the
 * model sees either way. A failed call is a turn of the conversation, not an
 * exception: the model is told what went wrong so it can correct itself.
 */
export interface ToolOutcome {
  ok: boolean;
  output: string;
  /** The output was withheld because the screen flagged it. */
  quarantined?: boolean;
  /** No call was made: the approval handler refused it. */
  declined?: boolean;
}

export interface ModelRoute {
  client: ChatProvider;
  model: string;
}

/** Ordered route chain with its non-empty invariant represented in the type. */
export type ModelRouteChain = readonly [ModelRoute, ...ModelRoute[]];

/** `security.screen` from solenoid-security, or anything with its contract. */
export type Screener = (input: TextInput) => Promise<ScreeningResult>;

export interface ApprovalRequest {
  tool: string;
  kind: ToolKind;
  /** Validated arguments: a call that fails its schema is refused before anybody is asked. */
  args: unknown;
  description: string;
  /** The run's signal. An approval outlives no run. */
  signal: AbortSignal;
}

/** Allowed, or refused with the sentence the model is given. */
export type ApprovalHandler = (request: ApprovalRequest) => ToolVerdict | Promise<ToolVerdict>;

export interface AgentLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const silentLogger: AgentLogger = { info() {}, warn() {} };

export interface RouteRef {
  provider: string;
  model: string;
}

/** Everything a run reports while it is in progress. */
export type AgentEvent =
  /** A model call is about to start. Partial output after this belongs to it. */
  | { type: 'turn_start'; turn: number; route: RouteRef }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  /** A turn finished and was added to the transcript. */
  | { type: 'assistant_turn'; message: ChatMessage }
  | { type: 'tool_start'; id: string; name: string; kind: ToolKind | 'unknown'; args: unknown }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      ok: boolean;
      output: string;
      durationMs: number;
      quarantined?: boolean;
      declined?: boolean;
    }
  /** The turn in progress failed transiently and will be re-requested. Discard its partial output. */
  | { type: 'retry'; turn: number; delayMs: number; error: string }
  /** The attempt failed and the task restarts on the next route. Discard the whole attempt. */
  | { type: 'route_advanced'; from: RouteRef; to: RouteRef; error: string }
  | {
      type: 'guardrail';
      boundary: ScreeningBoundary;
      decision: ScreeningResult['decision'];
      score?: number;
    }
  | { type: 'usage'; usage: TokenUsage };

export interface AgentOptions {
  /** Ordered, non-empty provider/model chain. A failed attempt advances one route. */
  routes: ModelRouteChain;
  systemPrompt?: string;
  tools?: AgentTool[];
  reviewers?: Reviewer[];
  think?: ThinkLevel;
  /** Per-attempt deadline, including model continuations and tool calls. */
  timeoutMs?: number;
  /** Name shown on the AGENT root span. */
  name?: string;
  /**
   * Screen inputs and every untrusted output boundary. Omit only where the
   * caller has decided there is nothing to screen; there is no default
   * detector because the core reads no configuration.
   */
  screen?: Screener;
  /** Which tools stop and ask. Defaults to every write. */
  requiresApproval?: (tool: AgentTool) => boolean;
  logger?: AgentLogger;
}

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Asked before every tool `requiresApproval` selects. Falls back to the
   * ambient gate from solenoid-security's `withToolGate`; with neither, the
   * call proceeds, as there is nobody to ask.
   */
  approve?: ApprovalHandler;
}

export interface RunResult<T = string> {
  output: T;
  /**
   * The full transcript after the run: the input messages (marked screened)
   * plus every assistant turn and tool result the successful attempt added.
   * Pass it back with the next user message to continue the conversation.
   */
  messages: ChatMessage[];
  /** Which route completed the run. */
  routeIndex: number;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface Attempt {
  client: ChatProvider;
  model: string;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  approve?: ApprovalHandler;
  schema?: z.ZodType;
  /** Set once a write tool has run. A committed attempt is never replayed. */
  committed: boolean;
}

export class Agent {
  protected readonly routes: ModelRouteChain;
  protected readonly systemPrompt?: string;
  protected readonly tools = new Map<string, AgentTool>();
  protected readonly reviewers = new Map<string, Reviewer>();
  protected readonly think: ThinkLevel;
  protected readonly timeoutMs: number;
  protected readonly name: string;
  private readonly screener?: Screener;
  private readonly requiresApproval: (tool: AgentTool) => boolean;
  private readonly log: AgentLogger;

  constructor(opts: AgentOptions) {
    if (!opts.routes.length) throw new Error('At least one model route must be configured');
    for (const route of opts.routes) {
      if (!route.model.trim()) throw new Error('Model route names cannot be empty');
    }
    this.routes = opts.routes;
    this.systemPrompt = opts.systemPrompt;
    this.think = opts.think ?? true;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive finite number');
    }
    this.name = opts.name ?? this.constructor.name;
    this.screener = opts.screen;
    this.requiresApproval = opts.requiresApproval ?? ((tool) => tool.kind === 'write');
    this.log = opts.logger ?? silentLogger;
    for (const tool of opts.tools ?? []) this.addTool(tool);
    for (const reviewer of opts.reviewers ?? []) this.addReviewer(reviewer);
  }

  addTool(tool: AgentTool): this {
    const name = tool.definition.function.name.trim();
    if (!name) throw new Error('Agent tools must have a non-empty name');
    if (name === SUBMIT_RESULT_TOOL_NAME) {
      throw new Error(`Agent tool name "${SUBMIT_RESULT_TOOL_NAME}" is reserved`);
    }
    if (this.tools.has(name)) throw new Error(`Agent tool "${name}" is already registered`);
    this.tools.set(name, tool);
    return this;
  }

  addReviewer(reviewer: Reviewer): this {
    const name = reviewer.name.trim();
    if (!name) throw new Error('Agent reviewers must have a non-empty name');
    if (this.reviewers.has(name)) throw new Error(`Agent reviewer "${name}" is already registered`);
    this.reviewers.set(name, reviewer);
    return this;
  }

  /** Tool definitions the model is offered, in registration order. */
  get toolDefinitions(): FunctionToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  /** One prompt in, one answer out. */
  async run(prompt: string, options: RunOptions = {}): Promise<string> {
    const result = await this.runMessages([{ role: 'user', content: prompt }], options);
    return result.output;
  }

  /** One prompt in, one schema-validated object out. */
  async runStructured<S extends z.ZodType>(
    prompt: string,
    schema: S,
    options: RunOptions = {}
  ): Promise<z.infer<S>> {
    const result = await this.runMessages([{ role: 'user', content: prompt }], {
      ...options,
      schema,
    });
    return result.output;
  }

  /**
   * Run a transcript through the loop. Without a system message, the agent's
   * own system prompt is prepended.
   */
  runMessages(messages: ChatMessage[], options?: RunOptions): Promise<RunResult<string>>;
  runMessages<S extends z.ZodType>(
    messages: ChatMessage[],
    options: RunOptions & { schema: S }
  ): Promise<RunResult<z.infer<S>>>;
  async runMessages(
    messages: ChatMessage[],
    options: RunOptions & { schema?: z.ZodType } = {}
  ): Promise<RunResult<unknown>> {
    const transcript =
      messages.some((m) => m.role === 'system') || !this.systemPrompt
        ? messages.map((m) => ({ ...m }))
        : [
            { role: 'system' as const, content: this.systemPrompt },
            ...messages.map((m) => ({ ...m })),
          ];
    return this.runTraced(transcript, options);
  }

  private runTraced(
    messages: ChatMessage[],
    options: RunOptions & { schema?: z.ZodType }
  ): Promise<RunResult<unknown>> {
    const emit = (event: AgentEvent) => {
      try {
        options.onEvent?.(event);
      } catch (error) {
        // A listener failing must not fail the run.
        this.log.warn({ error: String(error) }, '[agent] event listener threw');
      }
    };
    const external = options.signal ?? new AbortController().signal;

    return withSpanKind(
      'AGENT',
      this.name,
      {
        [SemanticConventions.INPUT_VALUE]: safeMessagesJson(messages),
        [SemanticConventions.INPUT_MIME_TYPE]: 'application/json',
        'agent.timeout_ms': this.timeoutMs,
        'agent.route_count': this.routes.length,
        ...Object.fromEntries(
          this.routes.flatMap((route, index) => [
            [`agent.routes.${index}.provider`, route.client.providerName],
            [`agent.routes.${index}.model`, route.model],
          ])
        ),
      },
      async (span) => {
        await this.screenInputs(messages, emit);
        for (let index = 0; index < this.routes.length; index++) {
          const route = this.routes[index]!;
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(new AgentTimeoutError(this.timeoutMs)),
            this.timeoutMs
          );
          const signal = AbortSignal.any([external, controller.signal]);
          const attempt: Attempt = {
            client: route.client,
            model: route.model,
            signal,
            emit,
            approve: options.approve,
            schema: options.schema,
            committed: false,
          };
          // Each attempt works on its own copy, so a failed trajectory never
          // leaks into the next route's replay.
          const working = messages.map((m) => ({ ...m }));
          try {
            const output = await this.runAttempt(working, attempt);
            span.setAttribute('agent.completed_route_index', index);
            span.setAttribute(
              SemanticConventions.OUTPUT_VALUE,
              typeof output === 'string' ? output : safeJson(output)
            );
            return { output, messages: working, routeIndex: index };
          } catch (rawError) {
            const error =
              external.aborted && !(rawError instanceof AgentAbortedError)
                ? new AgentAbortedError()
                : signal.aborted && signal.reason instanceof Error && !isScreeningFailure(rawError)
                  ? signal.reason
                  : rawError;
            const next = this.routes[index + 1];
            // Interrupts, injection verdicts and committed writes all end the
            // run here: replaying would ignore the person, retry an attack, or
            // repeat a change that already happened.
            if (
              error instanceof AgentAbortedError ||
              isScreeningFailure(error) ||
              attempt.committed ||
              !next
            ) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            const from = { provider: route.client.providerName, model: route.model };
            const to = { provider: next.client.providerName, model: next.model };
            span.addEvent('agent.route_advanced', {
              'route.failed_index': index,
              'route.failed_provider': from.provider,
              'route.failed_model': from.model,
              'route.next_provider': to.provider,
              'route.next_model': to.model,
              'route.error': message,
            });
            this.log.warn({ from, to, error: message }, '[route] attempt failed; advancing route');
            emit({ type: 'route_advanced', from, to, error: message });
          } finally {
            clearTimeout(timer);
          }
        }
        throw new AgentRunError('Model route chain was unexpectedly empty');
      }
    );
  }

  private async runAttempt(messages: ChatMessage[], attempt: Attempt): Promise<unknown> {
    const { schema } = attempt;
    if (!schema) return this.loop(messages, attempt);

    messages.push({
      role: 'system',
      content: `When the task is complete, call ${SUBMIT_RESULT_TOOL_NAME} with the final result.`,
      screened: true,
    });
    const raw = extractJson(await this.loop(messages, attempt));
    try {
      return schema.parse(JSON.parse(raw));
    } catch (err) {
      throw new AgentRunError(
        `Structured output failed validation after the run reported completion: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  protected async loop(messages: ChatMessage[], attempt: Attempt): Promise<string> {
    const { client, model, signal, emit, schema } = attempt;
    const submitDefinition: FunctionToolDefinition | undefined = schema
      ? {
          type: 'function',
          function: {
            name: SUBMIT_RESULT_TOOL_NAME,
            description: 'Submit the completed, schema-valid final result.',
            parameters: toJsonSchema(schema),
          },
        }
      : undefined;
    const toolDefs = [...this.toolDefinitions, ...(submitDefinition ? [submitDefinition] : [])];
    const route = { provider: client.providerName, model };

    let turn = 0;
    let retryDelayMs = 250;
    let retries = 0;
    while (true) {
      if (signal.aborted) throw abortReason(signal);
      turn++;
      emit({ type: 'turn_start', turn, route });

      let msg: ChatMessage;
      try {
        msg = await awaitWithSignal(
          client.chat(messages, {
            model,
            tools: toolDefs,
            think: this.think,
            signal,
            turn,
            onDelta: (delta) =>
              emit({
                type: delta.type === 'text' ? 'text_delta' : 'reasoning_delta',
                text: delta.text,
              }),
          }),
          signal
        );
        retryDelayMs = 250;
        retries = 0;
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        // Bounded, unlike the Assistant's loop: a person is watching, and an
        // LM Studio that is simply off should hand over to the next route in
        // seconds, not at the end of the attempt deadline.
        if (!isTransientProviderError(error) || retries >= MAX_TRANSIENT_RETRIES) throw error;
        retries++;
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn(
          { turn, retryInMs: retryDelayMs, error: message },
          '[retry] transient model call failure'
        );
        emit({ type: 'retry', turn, delayMs: retryDelayMs, error: message });
        await waitFor(retryDelayMs, signal);
        retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
        turn--;
        continue;
      }
      if (msg.usage) emit({ type: 'usage', usage: msg.usage });

      await this.screen(
        [
          msg.content,
          ...(msg.thinking ? [msg.thinking] : []),
          ...(msg.toolCalls ?? []).map((call) => safeJson(call.arguments)),
        ],
        'model_output',
        'external',
        emit
      );
      msg.screened = true;
      messages.push(msg); // keep the native payload for continuation
      emit({ type: 'assistant_turn', message: msg });

      if (msg.finishReason === 'content_filter' || msg.finishReason === 'refusal') {
        throw new AgentRunError(`Model declined the request (finish reason: ${msg.finishReason})`);
      }

      if (msg.toolCalls?.length) {
        let submitted: string | undefined;
        let submitFeedback: string | undefined;

        for (const call of msg.toolCalls) {
          if (submitDefinition && schema && call.name === SUBMIT_RESULT_TOOL_NAME) {
            if (msg.toolCalls.length > 1) {
              pushToolResult(
                messages,
                call.id,
                call.name,
                'Result deferred because this turn requested additional tools. ' +
                  'Use their results, then submit the final result in its own turn.'
              );
              continue;
            }
            const parsed = schema.safeParse(call.arguments);
            if (parsed.success) {
              submitted = JSON.stringify(parsed.data);
              const failed = (await this.reviewCandidate(messages, submitted, attempt)).filter(
                ({ result }) => !result.passed
              );
              if (!failed.length) return submitted;
              submitFeedback = failed
                .map(({ name, result }) => `${name} Feedback: ${result.feedback}`)
                .join('\n');
            } else {
              submitFeedback = parsed.error.message;
            }
            pushToolResult(messages, call.id, call.name, `Result rejected: ${submitFeedback}`);
            continue;
          }

          const tool = this.tools.get(call.name);
          emit({
            type: 'tool_start',
            id: call.id,
            name: call.name,
            kind: tool?.kind ?? 'unknown',
            args: call.arguments,
          });
          const started = performance.now();
          const result = await this.invokeTool(call.name, call.arguments, attempt);
          emit({
            type: 'tool_end',
            id: call.id,
            name: call.name,
            ok: result.ok,
            output: result.output,
            durationMs: performance.now() - started,
            ...(result.quarantined ? { quarantined: true } : {}),
            ...(result.declined ? { declined: true } : {}),
          });
          pushToolResult(messages, call.id, call.name, result.output);
        }

        if (submitted && submitFeedback) {
          messages.push({ role: 'system', content: submitFeedback, screened: true });
        }
        continue;
      }

      const content = msg.content.trim();
      if (
        msg.finishReason === 'length' ||
        (!content && (Boolean(schema) || Boolean(msg.thinking)))
      ) {
        this.log.warn(
          {
            turn,
            finishReason: msg.finishReason ?? 'unknown',
            reasoningChars: msg.thinking?.length ?? 0,
          },
          '[continue] model turn was incomplete'
        );
        messages.push({
          role: 'user',
          content: schema
            ? `Continue working. When complete, call ${SUBMIT_RESULT_TOOL_NAME} with the final result.`
            : 'Continue working and provide the complete final answer when ready.',
          screened: true,
        });
        // A local server can return an immediate empty response. Pace those
        // continuations so the deadline cannot turn into a hot loop.
        if (!content && !msg.thinking) await waitFor(100, signal);
        continue;
      }

      if (schema) {
        // Some models answer with the JSON itself rather than calling
        // submit_result. Accept that when it validates; repair it when not.
        const validation = validateStructured(content, schema);
        if (validation.ok) return extractJson(content);
        messages.push({
          role: 'user',
          content: `The candidate did not match the required schema: ${validation.error}. Continue working, then call ${SUBMIT_RESULT_TOOL_NAME}.`,
          screened: true,
        });
        continue;
      }

      const failed = (await this.reviewCandidate(messages, content, attempt)).filter(
        ({ result }) => !result.passed
      );
      if (!failed.length) return content;
      messages.push({
        role: 'system',
        content: failed
          .map(({ name, result }) => `${name} Feedback: ${result.feedback}`)
          .join('\n'),
        screened: true,
      });
    }
  }

  protected async reviewCandidate(
    messages: ChatMessage[],
    output: string,
    attempt: Attempt
  ): Promise<Array<{ name: string; result: ReviewResult }>> {
    const context = {
      output,
      messages: [...messages],
      signal: attempt.signal,
      client: attempt.client,
      model: attempt.model,
    };
    const reviews: Array<{ name: string; result: ReviewResult }> = [];
    for (const [name, reviewer] of this.reviewers) {
      const result = await withSpanKind(
        'EVALUATOR',
        name,
        { [SemanticConventions.INPUT_VALUE]: output },
        async (span) => {
          const review = await awaitWithSignal(reviewer.review(context), attempt.signal);
          await this.screen([review.feedback], 'reviewer_output', 'external', attempt.emit);
          span.setAttribute(SemanticConventions.OUTPUT_VALUE, safeJson(review));
          return review;
        }
      );
      reviews.push({ name, result });
    }
    return reviews;
  }

  protected async invokeTool(
    name: string,
    rawArgs: unknown,
    attempt: Attempt
  ): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return failed(`unknown tool "${name}"`);

    return withSpanKind(
      'TOOL',
      name,
      {
        [SemanticConventions.TOOL_NAME]: name,
        [SemanticConventions.TOOL_DESCRIPTION]: tool.definition.function.description,
        [SemanticConventions.TOOL_PARAMETERS]: safeJson(tool.definition.function.parameters),
      },
      async (span) => {
        // try/catch stays inside the span: errors mark the span but are
        // returned to the model so it can self-correct, not thrown.
        try {
          const args = tool.schema.parse(rawArgs); // validate at the boundary
          span.setAttribute(SemanticConventions.INPUT_VALUE, safeJson(args));

          // After the parse, so a call that cannot be made is refused on its
          // own terms rather than put to somebody; before the execute, which
          // is the only ordering that means anything.
          if (this.requiresApproval(tool)) {
            const gate = attempt.approve ?? currentToolGate();
            const verdict = await gate?.({
              tool: name,
              kind: tool.kind,
              args,
              description: tool.definition.function.description,
              signal: attempt.signal,
            });
            if (verdict && !verdict.allow) {
              span.setAttributes({
                'approval.allowed': false,
                [SemanticConventions.OUTPUT_VALUE]: verdict.tell,
              });
              // Not a failure: nothing failed and nothing ran. A refused write
              // is an ordinary turn of the conversation.
              return { ok: true, output: verdict.tell, declined: true };
            }
          }

          if (tool.kind === 'write') attempt.committed = true;
          const result = await awaitWithSignal(
            Promise.resolve(tool.execute(args, { signal: attempt.signal })),
            attempt.signal
          );
          const output = typeof result === 'string' ? result : JSON.stringify(result);
          // Every tool result is screened. The screen subtracts what this
          // repository wrote and judges the rest, so a result that is all our
          // own scaffolding costs nothing.
          const quarantined = await this.screen([output], 'tool_output', 'external', attempt.emit);
          if (quarantined) {
            span.setAttributes({ 'tool.quarantined': true });
            this.log.warn({ tool: name }, '[tool] output quarantined: prompt injection detected');
            return {
              ok: false,
              output: 'Error: Prompt injection detected in tool output; output blocked.',
              quarantined: true,
            };
          }
          span.setAttributes({
            [SemanticConventions.OUTPUT_VALUE]: output,
            [SemanticConventions.OUTPUT_MIME_TYPE]:
              typeof result === 'string' ? 'text/plain' : 'application/json',
          });
          return { ok: true, output };
        } catch (err) {
          if (isScreeningFailure(err) || attempt.signal.aborted) throw err;
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          return failed(err instanceof Error ? err.message : String(err));
        }
      }
    );
  }

  /**
   * Screen every input message the loop has not already seen, grouped by
   * declared origin so an injection split across two messages of the same
   * origin is still judged whole.
   */
  private async screenInputs(
    messages: ChatMessage[],
    emit: (event: AgentEvent) => void
  ): Promise<void> {
    const byOrigin = new Map<TextOrigin, ChatMessage[]>();
    for (const message of messages) {
      if (message.role === 'system' || message.screened) continue;
      const origin = message.origin ?? 'external';
      byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), message]);
    }
    for (const [origin, group] of byOrigin) {
      await this.screen(
        group.map((m) => m.content),
        'input',
        origin,
        emit
      );
      for (const message of group) message.screened = true;
    }
  }

  /**
   * Returns true when a tool output must be quarantined. Throws on a block
   * verdict and on any failure to reach a verdict: a screen that cannot
   * answer is not a pass.
   */
  private async screen(
    parts: readonly string[],
    boundary: ScreeningBoundary,
    origin: TextOrigin,
    emit: (event: AgentEvent) => void
  ): Promise<boolean> {
    if (!this.screener || parts.every((part) => !part.trim())) return false;

    const result = await withSpanKind(
      'GUARDRAIL',
      'prompt-injection-detection',
      {
        [SemanticConventions.INPUT_VALUE]: parts.join('\n'),
        'metadata.boundary': boundary,
        'metadata.origin': origin,
      },
      async (span) => {
        let screened: ScreeningResult;
        try {
          screened = await this.screener!({ type: 'text', content: [...parts], origin, boundary });
        } catch (error) {
          throw new PromptInjectionScreeningError({ cause: error });
        }
        span.setAttributes({
          'metadata.decision': screened.decision,
          'metadata.authored_chars_redacted': screened.authoredCharsRedacted,
          ...(screened.assessment && Number.isFinite(screened.assessment.score)
            ? { 'metadata.score': screened.assessment.score }
            : {}),
        });
        return screened;
      }
    );

    if (result.decision === 'allow') return false;
    const score = result.assessment?.score;
    emit({
      type: 'guardrail',
      boundary,
      decision: result.decision,
      ...(score !== undefined && Number.isFinite(score) ? { score } : {}),
    });
    if (result.decision === 'observe') {
      // The operator is the principal: a flag on their own text is worth a
      // record and not worth refusing to work over.
      this.log.warn({ boundary, origin, score }, '[guardrail] flagged operator text; continuing');
      return false;
    }
    if (result.decision === 'quarantine') return true;
    throw new PromptInjectionDetectedError(boundary);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lenient JSON recovery for backends that don't enforce the schema: peel off
 * code fences or surrounding prose. Validation still happens through zod.
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function validateStructured(
  raw: string,
  schema: z.ZodType
): { ok: true } | { ok: false; error: string } {
  const json = extractJson(raw);
  if (!json) return { ok: false, error: 'the response was empty' };
  try {
    schema.parse(JSON.parse(json));
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message };
  }
}

function failed(message: string): ToolOutcome {
  return { ok: false, output: `Error: ${message}` };
}

function pushToolResult(messages: ChatMessage[], id: string, name: string, content: string): void {
  messages.push({ role: 'tool', toolCallId: id, toolName: name, content, screened: true });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AgentAbortedError();
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The abort wins, but the abandoned promise may still reject; observe it
    // so it does not surface as an unhandled rejection.
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function isTransientProviderError(error: unknown): boolean {
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
    (candidate?.name === 'TypeError' && candidate?.message?.includes('fetch failed') === true)
  );
}
