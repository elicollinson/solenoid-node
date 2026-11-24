/**
 * Eval Cases
 *
 * A case puts one thing the harness asks of a model to a real model: a
 * fixture world, the agent's profile, the person's messages, and checks on
 * what happened. It is written in the harness's own terms (`AgentProfile`,
 * settings), so a feature added to either can be put to a case the day it
 * lands, with no change to the runner.
 *
 * A trial is one run of a case on one model. Its trajectory is saved as it
 * happened and graded afterwards (./report.ts), so a check can change without
 * running a model again.
 */
import type { z } from 'zod';
import type { AgentProfile, AgentTool, ChatMessage } from '../src/index.js';

/**
 * A fixture: in-memory state and the tools that read and change it. Built
 * fresh for every trial, and the whole of what a case can reach.
 */
export interface World<S = unknown> {
  /** JSON-serializable: saved with the trial as it stood when the run ended. */
  state: S;
  tools: AgentTool[];
}

/** One tool call the agent under test made, and what came of it. */
export interface ToolCallRecord {
  name: string;
  /** As the model sent them; text that was not a JSON object comes as `{ raw }`. */
  args: Record<string, unknown>;
  /** Which model call of the trial made it, from 1. Calls sharing a step were made together. */
  step: number;
  /** It ran and returned. False for a failed, declined, quarantined or unanswered call. */
  ok: boolean;
  /** What the model was told. */
  output: string;
  error?: string;
  declined?: boolean;
  quarantined?: boolean;
  /** The model got the call wrong: no such tool, or arguments its schema refused. */
  malformed?: boolean;
}

/** What one trial did, in the terms checks and metrics read. */
export interface Trajectory<S = unknown> {
  /** The answer of each turn that completed, in order. */
  answers: string[];
  /** A structured case's validated result. */
  output?: unknown;
  /** Why the run ended early, when it did. */
  error?: string;
  /** The calls of the agent under test. A subagent's own calls are not among them. */
  toolCalls: ToolCallRecord[];
  /** Model requests made, retried ones included. */
  modelCalls: number;
  retries: number;
  tokens: { input: number; output: number; reasoning: number };
  durationMs: number;
  /** The world's state when the run ended. */
  state: S;
}

/** One thing that must be true of a trial. A check that throws has failed. */
export interface Check<S = unknown> {
  name: string;
  pass: (trajectory: Trajectory<S>) => boolean;
}

export interface EvalCase<W extends World = World> {
  /**
   * `<feature>/<what it asks>`, unique. The first segment is the harness
   * contract the case measures and its row in the report. Saved trials are
   * keyed by the id, so renaming a case orphans them.
   */
  id: string;
  world: () => W;
  /** The agent under test. Defaults to one holding the world's tools. */
  profile?: (world: W) => AgentProfile;
  /** The person's messages, one turn each. */
  turns: string[];
  /** With a schema the case is one structured run (`harness.runStructured`) of its only turn. */
  schema?: z.ZodType;
  /**
   * How the person answers a write that asks: `'deny'` declines every one, a
   * function says whether to allow each. They are all allowed otherwise.
   */
  approve?: 'deny' | ((tool: string, args: Record<string, unknown>) => boolean);
  /** Settings the case itself needs (a tight `agent.max_turns`), over the run's. */
  settings?: Record<string, unknown>;
  /** Every trial must also end without a run error: `completed`, checked first. */
  checks: Check<W['state']>[];
  /**
   * The model's replies in one run that passes, in order. Never shown to a
   * model: `bun test` plays it back to prove the case can be passed and that
   * its checks accept a right answer.
   */
  reference?: ChatMessage[];
  /** Set by `sweep`: one size of a limit being probed. */
  sweep?: { id: string; size: number };
}

/** The profile a case's agent is opened with, before the runner answers its writes. */
export function profileOf(evalCase: EvalCase, world: World): AgentProfile {
  const own = evalCase.profile?.(world) ?? { tools: world.tools };
  // Never the live web: the fixture world is all a case may reach.
  return { ...own, exclude: [...(own.exclude ?? []), 'read_webpage'] };
}

/** The feature a case measures: its id's first segment. */
export const featureOf = (id: string): string => id.split('/')[0]!;

/** Declare a case, typed by its world; the runner holds them all as plain `EvalCase`s. */
export function defineCase<W extends World>(evalCase: EvalCase<W>): EvalCase {
  if (evalCase.schema && evalCase.turns.length !== 1) {
    throw new Error(`Case ${evalCase.id}: a structured case has exactly one turn`);
  }
  return evalCase as unknown as EvalCase;
}

/**
 * One case template at several sizes, to find where a model stops coping.
 * The report shows the pass rate at each size.
 */
export function sweep<W extends World>(
  id: string,
  sizes: number[],
  make: (size: number) => Omit<EvalCase<W>, 'id' | 'sweep'>
): EvalCase[] {
  return sizes.map((size) => ({
    ...defineCase({ ...make(size), id: `${id}/${size}` }),
    sweep: { id, size },
  }));
}
