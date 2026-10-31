/**
 * Harness Messages
 *
 * Wording shared by the UI and the non-interactive CLI: what the model is
 * told when a write is refused, and what a person is told when a run fails.
 */
import { ScreeningError } from '@elicollinson/solenoid-security';
import {
  AgentAbortedError,
  AgentTimeoutError,
  PromptInjectionDetectedError,
  PromptInjectionScreeningError,
} from '../core/index.js';

/**
 * What the model is told when a person says no.
 *
 * "Do not call it again" is there because without it a capable model treats
 * a refusal as a transient failure and repeats the call, putting the same
 * question back in front of the person. The last sentence says what the next
 * message may not claim: a small model otherwise answers a refused write with
 * "I'll do that", which is the one sentence that must not follow a decline.
 * (Wording carried over from Solenoid-Assistant src/agents/chat.ts.)
 */
export function declinedMessage(tool: string, reason: 'declined' | 'unattended'): string {
  const what =
    reason === 'declined'
      ? `The user declined ${tool}.`
      : `${tool} needs approval and this run is unattended (pass --yes to allow it).`;
  return `${what} NOTHING WAS DONE and nothing changed. Do not call it again. Your next message must say plainly that you have not done it — never describe the change as though it happened — and ask what they would rather you did.`;
}

/** One line for a person, for any error a run can end with. */
export function describeRunError(error: unknown): string {
  if (error instanceof AgentAbortedError) return 'Interrupted.';
  if (error instanceof PromptInjectionDetectedError) {
    return `Stopped: possible prompt injection detected at the ${error.boundary.replace('_', ' ')} boundary.`;
  }
  if (error instanceof PromptInjectionScreeningError) {
    const cause = error.cause;
    const detail =
      cause instanceof ScreeningError && cause.code === 'inconclusive'
        ? 'the judge gave no verdict'
        : cause instanceof Error
          ? cause.message
          : 'the judge could not be reached';
    return `Stopped: injection screening failed (${detail}). Check the screening model in /settings, or set screening.enabled: false.`;
  }
  if (error instanceof AgentTimeoutError) {
    return `Timed out after ${Math.round(error.timeoutMs / 1000)}s on every route.`;
  }
  return error instanceof Error ? error.message : String(error);
}
