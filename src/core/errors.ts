/**
 * Errors
 *
 * Everything a run can fail with, so callers dispatch on type rather than on
 * message text.
 */
import type { ScreeningBoundary as SecurityScreeningBoundary } from '@elicollinson/solenoid-security';

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

/**
 * Where untrusted text enters the loop: the messages a run starts from, and
 * the result of every tool that reaches the world (see `reachesWorld` in
 * ./tools.ts). The model's own turns are not screened. They are not
 * untrusted text, and against the Gemma judge an ordinary planning turn
 * ("I should read that URL") was flagged often enough to stop a quarter of
 * everyday runs. Injected text is caught where it arrives, before the model
 * reads it.
 */
export type ScreeningBoundary = Extract<SecurityScreeningBoundary, 'input' | 'tool_output'>;

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

/** An injection verdict, or no verdict at all. Either way the run ends here. */
export function isScreeningFailure(error: unknown): boolean {
  return (
    error instanceof PromptInjectionDetectedError || error instanceof PromptInjectionScreeningError
  );
}
