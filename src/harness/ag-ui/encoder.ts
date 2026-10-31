/**
 * AG-UI Encoder
 *
 * Turns the agent's own events (../../core/events.ts) into AG-UI 1.0 events
 * for one conversation turn. The core stays free of any UI protocol; this is
 * the one place that knows both.
 *
 * - Text and reasoning stream as TEXT_MESSAGE_* and REASONING_*; a model
 *   turn is a STEP.
 * - Tool calls are TOOL_CALL_START/ARGS/END when they start and
 *   TOOL_CALL_RESULT when they finish, with Solenoid's outcome fields (error,
 *   quarantined, declined) in the result's metadata.
 * - A display tool's content is an ACTIVITY_SNAPSHOT whose activityType names
 *   the component (../../display).
 * - A retry or a route change discards partial output, which AG-UI cannot
 *   retract event by event, so the encoder sends a MESSAGES_SNAPSHOT of what
 *   still stands.
 * - An approval ends the run with an interrupt outcome; answering it opens a
 *   new run that continues where the last one paused.
 */
import {
  type AGUIEvent,
  EventType,
  type Interrupt,
  type Message,
  type RunFinishedOutcome,
  type TokenUsage,
  aggregateTokenUsage,
} from '@ag-ui/core';
import type { AgentEvent, RouteRef } from '../../core/index.js';
import { SOLENOID_METADATA_KEY, type ToolResultMetadata } from './reducer.js';

/** Custom event names, for what AG-UI has no event of its own for. */
export const CUSTOM_EVENTS = {
  retry: 'solenoid.retry',
  routeAdvanced: 'solenoid.route_advanced',
  guardrail: 'solenoid.guardrail',
} as const;

/**
 * The `value` of each custom event: part of the contract, so built here
 * field by field rather than passing the core's own event through.
 */
export interface CustomEventValues {
  [CUSTOM_EVENTS.retry]: { error: string; delayMs: number };
  [CUSTOM_EVENTS.routeAdvanced]: { from: RouteRef; to: RouteRef; error: string };
  [CUSTOM_EVENTS.guardrail]: {
    boundary: 'input' | 'tool_output';
    decision: 'allow' | 'observe' | 'quarantine' | 'block';
    score?: number;
  };
}

export type CustomEventName = keyof CustomEventValues;

/** A CUSTOM event's value, typed by its name, or undefined for any other event. */
export function customValue<N extends CustomEventName>(
  event: AGUIEvent,
  name: N
): CustomEventValues[N] | undefined {
  return event.type === EventType.CUSTOM && event.name === name
    ? (event.value as CustomEventValues[N])
    : undefined;
}

export interface EncoderSink {
  /** Deliver one event. The session applies it to its thread before passing it on. */
  emit(event: AGUIEvent): void;
  /** The thread as it stands, for snapshots. */
  thread(): readonly Message[];
}

export class TurnEncoder {
  private runId: string | undefined;
  /** Thread length after the person's message: a route change rolls back to here. */
  private turnStart = 0;
  /** Thread length when the current model call began: a retry rolls back to here. */
  private stepStart = 0;
  private step = 0;
  private assistantId = '';
  private textOpen = false;
  private reasoningId: string | undefined;
  private route: RouteRef | undefined;
  private usage: TokenUsage[] = [];

  constructor(
    private readonly threadId: string,
    private readonly sink: EncoderSink
  ) {}

  /** Open the turn's first run with the person's message in it. */
  startTurn(user: { id: string; text: string }): void {
    this.startRun();
    this.emit({ type: EventType.TEXT_MESSAGE_START, messageId: user.id, role: 'user' });
    this.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: user.id, delta: user.text });
    this.emit({ type: EventType.TEXT_MESSAGE_END, messageId: user.id });
    this.turnStart = this.sink.thread().length;
  }

  /** Open a run: at the start of the turn, and again after each answered interrupt. */
  startRun(): void {
    this.runId = crypto.randomUUID();
    this.sink.emit({ type: EventType.RUN_STARTED, threadId: this.threadId, runId: this.runId });
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.route = event.route;
        this.stepStart = this.sink.thread().length;
        this.assistantId = crypto.randomUUID();
        this.step = event.turn;
        this.emit({ type: EventType.STEP_STARTED, stepName: `turn ${event.turn}` });
        break;

      case 'reasoning_delta':
        if (!this.reasoningId) {
          this.reasoningId = crypto.randomUUID();
          this.emit({ type: EventType.REASONING_START, messageId: this.reasoningId });
          this.emit({
            type: EventType.REASONING_MESSAGE_START,
            messageId: this.reasoningId,
            role: 'reasoning',
          });
        }
        this.emit({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: this.reasoningId,
          delta: event.text,
        });
        break;

      case 'text_delta':
        this.closeReasoning();
        if (!this.textOpen) {
          this.textOpen = true;
          this.emit({
            type: EventType.TEXT_MESSAGE_START,
            messageId: this.assistantId,
            role: 'assistant',
          });
        }
        this.emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: this.assistantId,
          delta: event.text,
        });
        break;

      case 'assistant_turn':
        this.closeStep();
        break;

      case 'tool_start':
        this.emit({
          type: EventType.TOOL_CALL_START,
          toolCallId: event.id,
          toolCallName: event.name,
          parentMessageId: this.assistantId,
        });
        this.emit({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: event.id,
          delta: JSON.stringify(event.args ?? {}),
        });
        this.emit({ type: EventType.TOOL_CALL_END, toolCallId: event.id });
        break;

      case 'display':
        this.emit({
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: `${event.id}:display`,
          activityType: event.component,
          content: event.content,
          replace: true,
        });
        break;

      case 'tool_end': {
        // The event has no error field of its own; the reducer moves this
        // one onto the tool message's native `error`.
        const outcome: ToolResultMetadata = {
          durationMs: event.durationMs,
          ...(event.error ? { error: event.error } : {}),
          ...(event.quarantined ? { quarantined: true } : {}),
          ...(event.declined ? { declined: true } : {}),
        };
        this.emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: `${event.id}:result`,
          toolCallId: event.id,
          content: event.output,
          role: 'tool',
          metadata: { [SOLENOID_METADATA_KEY]: outcome },
        });
        break;
      }

      case 'retry':
        this.closeStep();
        this.custom(CUSTOM_EVENTS.retry, { error: event.error, delayMs: event.delayMs });
        this.snapshot(this.stepStart);
        break;

      case 'route_advanced':
        this.closeStep();
        this.custom(CUSTOM_EVENTS.routeAdvanced, {
          from: event.from,
          to: event.to,
          error: event.error,
        });
        this.snapshot(this.turnStart);
        this.usage = [];
        break;

      case 'guardrail':
        this.custom(CUSTOM_EVENTS.guardrail, {
          boundary: event.boundary,
          decision: event.decision,
          ...(event.score !== undefined ? { score: event.score } : {}),
        });
        break;

      case 'usage':
        this.usage.push({
          provider: this.route?.provider,
          model: this.route?.model,
          inputTokens: event.usage.promptTokens,
          outputTokens: event.usage.completionTokens,
          totalTokens: event.usage.totalTokens,
          reasoningTokens: event.usage.reasoningTokens,
        });
        break;
    }
  }

  /** End the run waiting on these interrupts. */
  pause(interrupts: Interrupt[]): void {
    this.finish({ type: 'interrupt', interrupts });
  }

  /** End the run: it answered. */
  complete(): void {
    this.closeStep();
    this.finish({ type: 'success' });
  }

  /** End the run: the person stopped it. */
  cancel(): void {
    this.closeStep();
    this.finish({ type: 'cancelled' });
  }

  /** End the run: it failed. */
  fail(message: string, code?: string): void {
    if (!this.runId) return;
    this.closeStep();
    this.runId = undefined;
    this.sink.emit({
      type: EventType.RUN_ERROR,
      message,
      ...(code ? { code } : {}),
      ...this.usagePayload(),
    });
  }

  private finish(outcome: RunFinishedOutcome): void {
    const runId = this.runId;
    if (!runId) return;
    // Closed before the event goes out: a client may answer an interrupt
    // from its RUN_FINISHED handler, which opens the next run right away.
    this.runId = undefined;
    this.sink.emit({
      type: EventType.RUN_FINISHED,
      threadId: this.threadId,
      runId,
      outcome,
      ...(outcome.type === 'interrupt' ? {} : this.usagePayload()),
    });
  }

  private usagePayload(): { usage?: TokenUsage[] } {
    const usage = aggregateTokenUsage(this.usage);
    return usage.length ? { usage } : {};
  }

  private custom<N extends CustomEventName>(name: N, value: CustomEventValues[N]): void {
    this.emit({ type: EventType.CUSTOM, name, value });
  }

  private snapshot(length: number): void {
    this.emit({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: this.sink.thread().slice(0, length),
    });
  }

  private closeReasoning(): void {
    if (!this.reasoningId) return;
    this.emit({ type: EventType.REASONING_MESSAGE_END, messageId: this.reasoningId });
    this.emit({ type: EventType.REASONING_END, messageId: this.reasoningId });
    this.reasoningId = undefined;
  }

  /** Close whatever the current model call left open. */
  private closeStep(): void {
    this.closeReasoning();
    if (this.textOpen) {
      this.emit({ type: EventType.TEXT_MESSAGE_END, messageId: this.assistantId });
      this.textOpen = false;
    }
    if (this.step) {
      this.emit({ type: EventType.STEP_FINISHED, stepName: `turn ${this.step}` });
      this.step = 0;
    }
  }

  private emit(event: AGUIEvent): void {
    if (this.runId) this.sink.emit(event);
  }
}
