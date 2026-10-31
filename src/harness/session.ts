/**
 * Session
 *
 * One conversation with the agent, spoken in AG-UI. Holds two records of it
 * between turns:
 *
 * - the model's transcript, including the provider-native assistant payloads
 *   and tool results the next turn must replay;
 * - the AG-UI thread a client draws, kept with the same reducer a client
 *   uses (./ag-ui/reducer.ts), so a snapshot the session sends is exactly
 *   what the client would have built.
 *
 * Each user message is sent as operator text. A write that needs approval
 * ends the AG-UI run with an interrupt; `resume` answers it, and the turn
 * carries on in a new run.
 */
import type { AGUIEvent, Interrupt, Message, ResumeEntry } from '@ag-ui/core';
import type { ToolVerdict } from '@elicollinson/solenoid-security';
import {
  type Agent,
  AgentAbortedError,
  type ApprovalHandler,
  type ApprovalRequest,
  type ChatMessage,
} from '../core/index.js';
import { TurnEncoder } from './ag-ui/encoder.js';
import { applyEvent } from './ag-ui/reducer.js';
import { declinedMessage, describeRunError } from './messages.js';

/** The interrupt reason for a write waiting on a person. */
export const APPROVAL_REASON = 'tool_approval';

/** What an approval interrupt expects back: `{ approved: boolean }`. */
const APPROVAL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' } },
  required: ['approved'],
} as const;

export interface SendOptions {
  /** Every AG-UI event of the turn, in order. */
  onEvent: (event: AGUIEvent) => void;
  signal?: AbortSignal;
  /**
   * Who wrote the message, for the injection screen. A person typing to
   * their own agent by default; `agent` for a task one agent hands another.
   */
  origin?: 'operator' | 'agent';
}

export interface SessionOptions {
  /**
   * How writes are approved. By default each one ends the AG-UI run with an
   * interrupt for the client to answer with `resume`; with nobody there to
   * answer (an unattended CLI run, a subagent) pass a policy instead.
   */
  approve?: ApprovalHandler;
  /** Called once by `close`, for whatever the session holds (its subagents). */
  onClose?: () => void;
}

/** An approval policy for a session nobody is attending: decline every write, saying so. */
export function declineUnattended(request: ApprovalRequest): ToolVerdict {
  return { allow: false, tell: declinedMessage(request.tool, 'unattended') };
}

/**
 * The answer to an approval interrupt: allowed, declined by the person, or
 * left unanswered because nobody is there to ask (an unattended run).
 */
export function approvalAnswer(
  interruptId: string,
  answer: 'allow' | 'decline' | 'unattended'
): ResumeEntry {
  return answer === 'unattended'
    ? { interruptId, status: 'cancelled' }
    : { interruptId, status: 'resolved', payload: { approved: answer === 'allow' } };
}

export class Session {
  readonly threadId = crypto.randomUUID();
  private transcript: ChatMessage[] = [];
  private thread: Message[] = [];
  private readonly pending = new Map<string, (entry: ResumeEntry) => void>();

  private closed = false;

  constructor(
    private readonly agent: Agent,
    private readonly options: SessionOptions = {}
  ) {}

  /** Release what the session holds. Once only. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.onClose?.();
  }

  /** The AG-UI thread so far. */
  get messages(): readonly Message[] {
    return this.thread;
  }

  /**
   * Run one turn. Resolves once the agent has answered, across any
   * interrupts in between; rejects with the error that ended it, after the
   * stream has reported it (RUN_ERROR, or a cancelled RUN_FINISHED).
   */
  async send(text: string, { onEvent, signal, origin = 'operator' }: SendOptions): Promise<string> {
    const user: ChatMessage = { role: 'user', content: text, origin };
    const encoder = new TurnEncoder(this.threadId, {
      emit: (event) => {
        this.thread = applyEvent(this.thread, event);
        onEvent(event);
      },
      thread: () => this.thread,
    });

    // Synchronous up to the agent's first await, so a client draws the
    // person's message the moment it calls send.
    encoder.startTurn({ id: crypto.randomUUID(), text });
    try {
      const result = await this.agent.runMessages([...this.transcript, user], {
        signal,
        onEvent: (event) => encoder.handle(event),
        approve: this.options.approve ?? ((request) => this.interrupt(request, encoder)),
      });
      this.transcript = result.messages;
      encoder.complete();
      return result.output;
    } catch (error) {
      // The turn's work is lost, but what was asked is kept so a follow-up
      // ("try again", "continue") still has its context. It is not marked
      // screened, so the next turn screens it again.
      this.transcript = [...this.transcript, user];
      if (error instanceof AgentAbortedError) encoder.cancel();
      else encoder.fail(describeRunError(error), (error as { code?: string }).code);
      throw error;
    }
  }

  /** Answer interrupts the last run ended on. Each opens the run that continues it. */
  resume(entries: ResumeEntry[]): void {
    for (const entry of entries) {
      const answer = this.pending.get(entry.interruptId);
      if (!answer) throw new Error(`No interrupt is waiting with id ${entry.interruptId}`);
      answer(entry);
    }
  }

  clear(): void {
    this.transcript = [];
    this.thread = [];
  }

  /**
   * A write waiting on a person: end the AG-UI run with an interrupt, and
   * hold the agent's call until `resume` answers it or the turn is stopped.
   */
  private interrupt(request: ApprovalRequest, encoder: TurnEncoder): Promise<ToolVerdict> {
    const interrupt: Interrupt = {
      id: `approval:${request.toolCallId}`,
      reason: APPROVAL_REASON,
      message: `Allow ${request.tool}? ${request.description.split('\n')[0] ?? ''}`.trim(),
      toolCallId: request.toolCallId,
      responseSchema: APPROVAL_RESPONSE_SCHEMA,
    };
    return new Promise<ToolVerdict>((resolve) => {
      const settle = (verdict: ToolVerdict) => {
        request.signal.removeEventListener('abort', onAbort);
        this.pending.delete(interrupt.id);
        resolve(verdict);
      };
      // Stopped while waiting: nothing ran, and the loop sees the abort next.
      const onAbort = () =>
        settle({ allow: false, tell: declinedMessage(request.tool, 'declined') });
      request.signal.addEventListener('abort', onAbort, { once: true });
      // Registered before the run ends, so a client may answer from inside
      // its RUN_FINISHED handler.
      this.pending.set(interrupt.id, (entry) => {
        encoder.startRun();
        settle(verdictFor(entry, request.tool));
      });
      encoder.pause([interrupt]);
    });
  }
}

/** The reading of `approvalAnswer`: only a resolved `approved: true` allows the call. */
function verdictFor(entry: ResumeEntry, tool: string): ToolVerdict {
  if (entry.status === 'resolved' && (entry.payload as { approved?: unknown })?.approved === true) {
    return { allow: true };
  }
  return {
    allow: false,
    tell: declinedMessage(tool, entry.status === 'cancelled' ? 'unattended' : 'declined'),
  };
}
