/**
 * A chat provider that answers from a script, streaming text as deltas. No
 * network.
 */
import type { ChatMessage, ChatOptions, ChatProvider } from '../../src/core/index.js';

export type Step = ChatMessage | Error | ((messages: ChatMessage[], opts: ChatOptions) => ChatMessage);

/** Answers each call with the next scripted step, streaming text as deltas. */
export class ScriptedProvider implements ChatProvider {
  readonly calls: ChatMessage[][] = [];
  /** The names of the tools offered on each call. */
  readonly offered: string[][] = [];

  constructor(
    readonly providerName: string,
    private readonly steps: Step[]
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    this.calls.push(messages.map((m) => ({ ...m })));
    this.offered.push(opts.tools.map((t) => t.function.name));
    const step = this.steps.shift();
    if (!step) throw new Error(`${this.providerName}: script exhausted`);
    if (step instanceof Error) throw step;
    const msg = typeof step === 'function' ? step(messages, opts) : step;
    if (msg.content) opts.onDelta?.({ type: 'text', text: msg.content });
    return msg;
  }
}

export const say = (content: string): ChatMessage => ({ role: 'assistant', content });
export const call = (name: string, args: unknown, id = `call_${name}`): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, arguments: args }],
});

