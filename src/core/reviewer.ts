/**
 * Reviewers
 *
 * Optional, independently configurable checks of an agent's candidate answer.
 * When an agent has reviewers, every candidate must pass all of them before
 * the loop returns it; failed feedback is supplied for one more turn.
 *
 * Ported from Solenoid-Assistant src/core/reviewer.ts.
 */
import type { ChatMessage, ChatProvider } from './providers.js';

/** The candidate and conversation snapshot supplied to a reviewer. */
export interface ReviewContext {
  readonly output: string;
  readonly messages: readonly ChatMessage[];
  readonly signal?: AbortSignal;
  /** Provider route used by the attempt that produced the candidate. */
  readonly client?: ChatProvider;
  readonly model?: string;
}

export interface ReviewResult {
  readonly passed: boolean;
  readonly feedback: string;
}

export interface Reviewer {
  readonly name: string;
  review(context: ReviewContext): Promise<ReviewResult>;
}
