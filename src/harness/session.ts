/**
 * Session
 *
 * One conversation with the agent. Holds the transcript between turns,
 * including the provider-native assistant payloads and tool results the next
 * turn must replay, and sends each user message as operator text.
 */
import type { Agent, ChatMessage, RunOptions } from '../core/index.js';

export class Session {
  private transcript: ChatMessage[] = [];

  constructor(private readonly agent: Agent) {}

  /** Run one turn. Resolves to the agent's answer. */
  async send(text: string, options: RunOptions = {}): Promise<string> {
    const user: ChatMessage = { role: 'user', content: text, origin: 'operator' };
    try {
      const result = await this.agent.runMessages([...this.transcript, user], options);
      this.transcript = result.messages;
      return result.output;
    } catch (error) {
      // The turn's work is lost, but what was asked is kept so a follow-up
      // ("try again", "continue") still has its context. It is not marked
      // screened, so the next turn screens it again.
      this.transcript = [...this.transcript, user];
      throw error;
    }
  }

  clear(): void {
    this.transcript = [];
  }

  get messages(): readonly ChatMessage[] {
    return this.transcript;
  }
}
