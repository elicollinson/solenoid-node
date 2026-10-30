/**
 * Abort
 *
 * The one answer to "what does an aborted signal throw": its reason when that
 * is an Error (a timeout, say), otherwise AgentAbortedError. Shared by the
 * loop and the provider so callers can dispatch on one error type.
 */

/** The caller's signal fired. Never retried, never advanced to another route. */
export class AgentAbortedError extends Error {
  readonly code = 'AGENT_ABORTED';

  constructor() {
    super('Agent run was interrupted');
    this.name = 'AgentAbortedError';
  }
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AgentAbortedError();
}
