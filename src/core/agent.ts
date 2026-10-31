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
 * - Injection screening of untrusted text (input messages and the results of
 *   tools that reach the world), through solenoid-security.
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
  currentToolGate,
} from '@elicollinson/solenoid-security';
import { z } from 'zod';
import {
  AgentAbortedError,
  AgentRunError,
  AgentTimeoutError,
  PromptInjectionDetectedError,
  PromptInjectionScreeningError,
  type ScreeningBoundary,
  isScreeningFailure,
} from './errors.js';
import type { AgentEvent, ToolOutcome } from './events.js';
import {
  type ChatMessage,
  type ChatProvider,
  type ModelRouteChain,
  type ThinkLevel,
  type ToolCall,
  isTransientProviderError,
} from './providers.js';
import type { Reviewer } from './reviewer.js';
import { Deadline, abortReason, awaitWithSignal, waitFor } from './signals.js';
import { extractJson, validateStructured } from './structured.js';
import {
  type AgentTool,
  type ApprovalHandler,
  type FunctionToolDefinition,
  reachesWorld,
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
/**
 * Model calls per attempt. The last one is offered no tools, so a model that
 * keeps calling them (redrawing a chart it cannot see, say) has to answer
 * with what it has instead of running until the deadline.
 */
export const DEFAULT_MAX_TURNS = 25;
const SUBMIT_RESULT_TOOL_NAME = 'submit_result';
/** What the model is told after a display tool's content reached the person. */
const DISPLAY_NOTICE = 'Shown to the person in the chat.';
/** What the model is told when it asks to show exactly what it already showed. */
const ALREADY_SHOWN_NOTICE =
  'Already shown to the person, unchanged, so it was not drawn again. Do not repeat it.';
/** What the model is told in place of a quarantined tool output. */
const QUARANTINE_NOTICE = 'Error: Prompt injection detected in tool output; output blocked.';

/** Consecutive transient failures of one model call before the attempt fails. */
const MAX_TRANSIENT_RETRIES = 4;

/** `security.screen` from solenoid-security, or anything with its contract. */
export type Screener = (input: TextInput) => Promise<ScreeningResult>;

export interface AgentLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const silentLogger: AgentLogger = { info() {}, warn() {} };

export interface AgentOptions {
  /** Ordered, non-empty provider/model chain. A failed attempt advances one route. */
  routes: ModelRouteChain;
  systemPrompt?: string;
  tools?: AgentTool[];
  reviewers?: Reviewer[];
  think?: ThinkLevel;
  /** Per-attempt deadline, including model continuations and tool calls. */
  timeoutMs?: number;
  /** Model calls per attempt; the last is offered no tools. */
  maxTurns?: number;
  /** Name shown on the AGENT root span. */
  name?: string;
  /**
   * Screen input messages and tool results. Omit only where the
   * caller has decided there is nothing to screen; there is no default
   * detector because the core reads no configuration.
   */
  screen?: Screener;
  /** Which tools that reach the world stop and ask. Defaults to every write. Internal tools never ask. */
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
  deadline: Deadline;
  /** Display content already shown this attempt, so an identical call is not drawn twice. */
  shown: Set<string>;
}

export class Agent {
  private readonly routes: ModelRouteChain;
  private readonly systemPrompt?: string;
  private readonly tools = new Map<string, AgentTool>();
  private readonly reviewers = new Map<string, Reviewer>();
  private readonly think: ThinkLevel;
  private readonly timeoutMs: number;
  private readonly maxTurns: number;
  private readonly name: string;
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
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    if (!Number.isInteger(this.maxTurns) || this.maxTurns < 1) {
      throw new Error('maxTurns must be a positive integer');
    }
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
      () => ({
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
      }),
      async (span) => {
        await this.screenInputs(messages, emit);
        for (let index = 0; index < this.routes.length; index++) {
          const route = this.routes[index]!;
          const controller = new AbortController();
          const deadline = new Deadline(this.timeoutMs, () =>
            controller.abort(new AgentTimeoutError(this.timeoutMs))
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
            deadline,
            shown: new Set(),
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
            deadline.clear();
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
    });
    const validation = validateStructured(await this.loop(messages, attempt), schema);
    if (!validation.ok) {
      throw new AgentRunError(
        `Structured output failed validation after the run reported completion: ${validation.error}`
      );
    }
    return validation.data;
  }

  private async loop(messages: ChatMessage[], attempt: Attempt): Promise<string> {
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
    let toldFinalTurn = false;
    while (true) {
      if (signal.aborted) throw abortReason(signal);
      turn++;
      if (turn > this.maxTurns) {
        throw new AgentRunError(`No answer after ${this.maxTurns} model turns`);
      }
      const finalTurn = turn === this.maxTurns;
      if (finalTurn && !toldFinalTurn) {
        toldFinalTurn = true;
        // A user turn, like the continuation prompts: chat templates such as
        // Gemma's accept a system message only at the start.
        messages.push({
          role: 'user',
          content:
            'This is your last turn and no tools are available. Answer now from what you already have, and say plainly what you could not finish.',
          screened: true,
        });
      }
      emit({ type: 'turn_start', turn, route });

      let msg: ChatMessage;
      try {
        msg = await awaitWithSignal(
          client.chat(messages, {
            model,
            tools: finalTurn ? [] : toolDefs,
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

      msg.screened = true;
      messages.push(msg); // keep the native payload for continuation
      emit({ type: 'assistant_turn', message: msg });

      if (msg.finishReason === 'content_filter' || msg.finishReason === 'refusal') {
        throw new AgentRunError(`Model declined the request (finish reason: ${msg.finishReason})`);
      }

      if (msg.toolCalls?.length && finalTurn) {
        // Offered none: a backend that relays a call anyway must not run it.
        throw new AgentRunError(`Model still called tools on its last turn (${this.maxTurns})`);
      }
      if (msg.toolCalls?.length) {
        // One output per call, in call order. Everything but a write runs
        // concurrently, screens included. A write waits for the calls before
        // it and holds back the ones after, because it may stop for approval
        // and commits the attempt.
        const outputs: Array<Promise<ToolOutcome>> = [];
        let reads: Array<Promise<ToolOutcome>> = [];
        let reviewerFeedback: string | undefined;
        const told = (output: string): Promise<ToolOutcome> =>
          Promise.resolve({ ok: true, output });

        for (const call of msg.toolCalls) {
          if (submitDefinition && schema && call.name === SUBMIT_RESULT_TOOL_NAME) {
            if (msg.toolCalls.length > 1) {
              outputs.push(
                told(
                  'Result deferred because this turn requested additional tools. ' +
                    'Use their results, then submit the final result in its own turn.'
                )
              );
              continue;
            }
            const parsed = schema.safeParse(call.arguments);
            if (!parsed.success) {
              outputs.push(told(`Result rejected: ${z.prettifyError(parsed.error)}`));
              continue;
            }
            const submitted = JSON.stringify(parsed.data);
            reviewerFeedback = await this.reviewFeedback(messages, submitted, attempt);
            if (!reviewerFeedback) return submitted;
            outputs.push(told(`Result rejected: ${reviewerFeedback}`));
            continue;
          }

          const kind = this.tools.get(call.name)?.kind;
          // Unknown tools fail fast; they go the sequential way like a write.
          if (kind && kind !== 'write') {
            const output = this.runToolCall(call, attempt);
            reads.push(output);
            outputs.push(output);
            continue;
          }
          await Promise.all(reads);
          reads = [];
          const output = await this.runToolCall(call, attempt);
          outputs.push(Promise.resolve(output));
        }

        const results = await Promise.all(outputs);
        msg.toolCalls.forEach((call, i) => {
          pushToolResult(messages, call.id, call.name, results[i]!.output);
        });
        if (reviewerFeedback) messages.push({ role: 'system', content: reviewerFeedback });

        // A display call's `done` ends the reply, but only when the turn
        // holds nothing else: a read's result is still the model's to read.
        const done =
          msg.toolCalls.every((call) => this.tools.get(call.name)?.kind === 'display') &&
          results.some((r) => r.done);
        if (done && !schema) {
          const answer = msg.content.trim();
          const feedback = await this.reviewFeedback(messages, answer, attempt);
          if (!feedback) return answer;
          messages.push({ role: 'system', content: feedback });
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

      const feedback = await this.reviewFeedback(messages, content, attempt);
      if (!feedback) return content;
      messages.push({ role: 'system', content: feedback });
    }
  }

  /** Run one tool call, reporting its start and end. Resolves to its outcome. */
  private async runToolCall(call: ToolCall, attempt: Attempt): Promise<ToolOutcome> {
    const { id, name } = call;
    attempt.emit({
      type: 'tool_start',
      id,
      name,
      kind: this.tools.get(name)?.kind ?? 'unknown',
      args: call.arguments,
    });
    const started = performance.now();
    const result = await this.invokeTool(call, attempt);
    const durationMs = Math.round(performance.now() - started);
    // A failure is logged with what was sent: the record a person needs to
    // see why a call keeps failing. Successes stay one short line.
    if (result.ok) {
      this.log.info({ tool: name, durationMs, declined: result.declined }, '[tool] call');
    } else {
      this.log.warn(
        {
          tool: name,
          durationMs,
          error: result.error,
          quarantined: result.quarantined,
          args: truncate(safeJson(call.arguments), MAX_ECHOED_ARGS_CHARS),
        },
        '[tool] call failed'
      );
    }
    attempt.emit({ type: 'tool_end', id, name, durationMs, ...result });
    return result;
  }

  /**
   * Put a candidate to every reviewer, concurrently. Resolves to the combined
   * feedback of those that failed it, or undefined when all passed.
   */
  private async reviewFeedback(
    messages: ChatMessage[],
    output: string,
    attempt: Attempt
  ): Promise<string | undefined> {
    if (!this.reviewers.size) return undefined;
    const context = {
      output,
      messages: [...messages],
      signal: attempt.signal,
      client: attempt.client,
      model: attempt.model,
    };
    const reviews = await Promise.all(
      [...this.reviewers].map(([name, reviewer]) =>
        withSpanKind(
          'EVALUATOR',
          name,
          () => ({ [SemanticConventions.INPUT_VALUE]: output }),
          async (span) => {
            const review = await awaitWithSignal(reviewer.review(context), attempt.signal);
            span.setAttribute(SemanticConventions.OUTPUT_VALUE, safeJson(review));
            return { name, review };
          }
        )
      )
    );
    const failed = reviews.filter(({ review }) => !review.passed);
    if (!failed.length) return undefined;
    return failed.map(({ name, review }) => `${name} Feedback: ${review.feedback}`).join('\n');
  }

  private async invokeTool(call: ToolCall, attempt: Attempt): Promise<ToolOutcome> {
    const { id, name, arguments: rawArgs } = call;
    const tool = this.tools.get(name);
    if (!tool) return failed(`unknown tool "${name}"`);

    return withSpanKind(
      'TOOL',
      name,
      () => ({
        [SemanticConventions.TOOL_NAME]: name,
        [SemanticConventions.TOOL_DESCRIPTION]: tool.definition.function.description,
        [SemanticConventions.TOOL_PARAMETERS]: safeJson(tool.definition.function.parameters),
      }),
      async (span) => {
        // try/catch stays inside the span: errors mark the span but are
        // returned to the model so it can self-correct, not thrown.
        try {
          // Validate at the boundary, and say what was wrong with what was sent:
          // a model can only correct a call it can see the fault in.
          const parsed = tool.schema.safeParse(rawArgs);
          if (!parsed.success) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            return failed(argumentError(rawArgs, parsed.error));
          }
          const args = parsed.data;
          if (span.isRecording())
            span.setAttribute(SemanticConventions.INPUT_VALUE, safeJson(args));

          // After the parse, so a call that cannot be made is refused on its
          // own terms rather than put to somebody; before the execute, which
          // is the only ordering that means anything.
          if (reachesWorld(tool.kind) && this.requiresApproval(tool)) {
            const gate = attempt.approve ?? currentToolGate();
            const verdict = await gate?.({
              tool: name,
              toolCallId: id,
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
            Promise.resolve(
              tool.execute(tool.kind === 'display' ? withoutDone(args) : args, {
                signal: attempt.signal,
                commit: () => {
                  attempt.committed = true;
                },
                untimed: (promise) => attempt.deadline.hold(promise),
              })
            ),
            attempt.signal
          );
          if (tool.kind === 'display') {
            // The content goes to the person; the model hears that it arrived.
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
              throw new Error('a display tool must return an object of component content');
            }
            const done = (parsed.data as { done?: boolean }).done === true;
            // Showing the same thing twice is never wanted.
            const json = safeJson(result);
            const key = `${tool.component}:${json}`;
            if (attempt.shown.has(key)) return { ok: true, output: ALREADY_SHOWN_NOTICE, done };
            attempt.shown.add(key);
            attempt.emit({
              type: 'display',
              id,
              name,
              component: tool.component!,
              content: result as Record<string, unknown>,
            });
            span.setAttribute(SemanticConventions.OUTPUT_VALUE, json);
            return { ok: true, output: DISPLAY_NOTICE, done };
          }
          const output = typeof result === 'string' ? result : JSON.stringify(result);
          // An internal tool's output is the model's own text. The screen
          // subtracts what this repository wrote and judges the rest.
          const quarantined =
            reachesWorld(tool.kind) &&
            (await this.screen([output], 'tool_output', 'external', attempt.emit));
          if (quarantined) {
            span.setAttributes({ 'tool.quarantined': true });
            this.log.warn({ tool: name }, '[tool] output quarantined: prompt injection detected');
            return {
              ok: false,
              output: QUARANTINE_NOTICE,
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
      () => ({
        [SemanticConventions.INPUT_VALUE]: parts.join('\n'),
        'metadata.boundary': boundary,
        'metadata.origin': origin,
      }),
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
      ...(Number.isFinite(score) ? { score } : {}),
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

const MAX_ECHOED_ARGS_CHARS = 400;

/**
 * Why a call's arguments were refused, in a form the model can act on. A
 * string means the provider could not parse the model's JSON; zod alone
 * would only say "expected object, received string".
 */
function argumentError(rawArgs: unknown, error: z.ZodError): string {
  if (typeof rawArgs === 'string') {
    return `the arguments were not valid JSON, so the call was not made. Send one JSON object. Received: ${truncate(rawArgs, MAX_ECHOED_ARGS_CHARS)}`;
  }
  return `invalid arguments, so the call was not made.\n${z.prettifyError(error)}\nYou sent: ${truncate(safeJson(rawArgs), MAX_ECHOED_ARGS_CHARS)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A display call's arguments as its tool defined them, without the loop's `done`. */
function withoutDone(args: unknown): unknown {
  const { done: _done, ...rest } = args as Record<string, unknown>;
  return rest;
}

function failed(message: string): ToolOutcome {
  return { ok: false, output: `Error: ${message}`, error: message };
}

function pushToolResult(messages: ChatMessage[], id: string, name: string, content: string): void {
  messages.push({ role: 'tool', toolCallId: id, toolName: name, content, screened: true });
}
