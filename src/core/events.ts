/**
 * Events
 *
 * What a run reports while it is in progress, and what one tool call came
 * back with. The UI and the CLI render from these.
 */
import type { ScreeningResult } from '@elicollinson/solenoid-security';
import type { ScreeningBoundary } from './errors.js';
import type { ChatMessage, TokenUsage } from './providers.js';
import type { AgentToolKind } from './tools.js';

/**
 * What one tool call came back with, and whether it worked.
 *
 * `ok` is carried rather than inferred from the wording: an MCP server can
 * relay a remote message starting "Error: " verbatim, and a caller re-reading
 * prose would record a successful call as a failure. `output` is what the
 * model sees either way. A failed call is a turn of the conversation, not an
 * exception: the model is told what went wrong so it can correct itself.
 */
export interface ToolOutcome {
  ok: boolean;
  output: string;
  /** Why the call failed, as a plain message: what `output` says to the model, without the framing. */
  error?: string;
  /** The output was withheld because the screen flagged it. */
  quarantined?: boolean;
  /** No call was made: the approval handler refused it. */
  declined?: boolean;
}

export interface RouteRef {
  provider: string;
  model: string;
}

/** Everything a run reports while it is in progress. */
export type AgentEvent =
  /** A model call is about to start. Partial output after this belongs to it. */
  | { type: 'turn_start'; turn: number; route: RouteRef }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  /** A turn finished and was added to the transcript. */
  | { type: 'assistant_turn'; message: ChatMessage }
  | { type: 'tool_start'; id: string; name: string; kind: AgentToolKind | 'unknown'; args: unknown }
  /** A display tool's content, for the person. `id` is the tool call's. */
  | {
      type: 'display';
      id: string;
      name: string;
      component: string;
      content: Record<string, unknown>;
    }
  | ({ type: 'tool_end'; id: string; name: string; durationMs: number } & ToolOutcome)
  /** The turn in progress failed transiently and will be re-requested. Discard its partial output. */
  | { type: 'retry'; turn: number; delayMs: number; error: string }
  /** The attempt failed and the task restarts on the next route. Discard the whole attempt. */
  | { type: 'route_advanced'; from: RouteRef; to: RouteRef; error: string }
  | {
      type: 'guardrail';
      boundary: ScreeningBoundary;
      decision: ScreeningResult['decision'];
      score?: number;
    }
  | { type: 'usage'; usage: TokenUsage };
