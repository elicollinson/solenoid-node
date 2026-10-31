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

/** One line for a person when a model route failed and the next one takes over. */
export function describeRouteAdvance(route: {
  from: { provider: string };
  to: { provider: string };
}): string {
  return `${route.from.provider} failed; switching to ${route.to.provider}`;
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
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'terminated') {
    return 'The model server closed the connection mid-response. Check its log (LM Studio: Developer → Logs); a conversation longer than the loaded context length is a common cause.';
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 500) {
    return `The model server failed (HTTP ${status}: ${plainText(message.replace(/^\d{3}\s*/, ''))}). Check its log (LM Studio: Developer → Logs); a conversation longer than the loaded context length is a common cause.`;
  }
  return plainText(message);
}

const MAX_ERROR_CHARS = 300;

/**
 * An error body as one readable line. Servers answer some failures with an
 * HTML page, which would otherwise be printed tag by tag.
 */
function plainText(message: string): string {
  const text = message
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}
