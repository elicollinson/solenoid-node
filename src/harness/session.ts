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
  type ApprovalRequest,
  type ChatMessage,
} from '../core/index.js';
import { TurnEncoder } from './ag-ui/encoder.js';
import { applyEvent } from './ag-ui/reducer.js';
import { declinedMessage, describeRunError } from './messages.js';

/** The interrupt reason for a write waiting on a person. */
export const APPROVAL_REASON = 'tool_approval';

/** What an approval interrupt expects back: `{ approved: boolean }`. */
export const APPROVAL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: { approved: { type: 'boolean' } },
  required: ['approved'],
} as const;

export interface SendOptions {
  /** Every AG-UI event of the turn, in order. */
  onEvent: (event: AGUIEvent) => void;
  signal?: AbortSignal;
  /** The id of the person's message in the thread, when the client has already drawn it. */
  messageId?: string;
}

export class Session {
  readonly threadId = crypto.randomUUID();
  private transcript: ChatMessage[] = [];
  private thread: Message[] = [];
  private readonly pending = new Map<string, (entry: ResumeEntry) => void>();

  constructor(private readonly agent: Agent) {}

  /** The AG-UI thread so far. */
  get messages(): readonly Message[] {
    return this.thread;
  }

  /** Interrupts waiting for an answer. */
  get waiting(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * Run one turn. Resolves once the agent has answered, across any
   * interrupts in between; rejects with the error that ended it, after the
   * stream has reported it (RUN_ERROR, or a cancelled RUN_FINISHED).
   */
  async send(text: string, { onEvent, signal, messageId }: SendOptions): Promise<string> {
    const user: ChatMessage = { role: 'user', content: text, origin: 'operator' };
    const id = messageId ?? crypto.randomUUID();
    this.thread = [...this.thread, { id, role: 'user', content: text }];
    const encoder = new TurnEncoder(this.threadId, {
      emit: (event) => {
        this.thread = applyEvent(this.thread, event);
        onEvent(event);
      },
      thread: () => this.thread,
    });

    encoder.startRun();
    try {
      const result = await this.agent.runMessages([...this.transcript, user], {
        signal,
        onEvent: (event) => encoder.handle(event),
        approve: (request) => this.interrupt(request, encoder),
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

/**
 * A resolved answer with `approved: true` allows the call. Anything else
 * declines it: "resolved" with `approved: false` is a person saying no;
 * "cancelled" means nobody answered, as in an unattended run.
 */
function verdictFor(entry: ResumeEntry, tool: string): ToolVerdict {
  if (entry.status === 'resolved' && (entry.payload as { approved?: unknown })?.approved === true) {
    return { allow: true };
  }
  return {
    allow: false,
    tell: declinedMessage(tool, entry.status === 'cancelled' ? 'unattended' : 'declined'),
  };
}
