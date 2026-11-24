/**
 * Checks
 *
 * The checks cases share. Each is a named, pure reading of a trajectory, so
 * saved trials can be graded again. A case with a one-off condition writes
 * its own `{ name, pass }` inline.
 */
import type { Check, ToolCallRecord, Trajectory } from './case.js';

/** Whether `actual` holds everything in `expected`: objects by subset, the rest by equality. */
function holds(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) =>
    holds((actual as Record<string, unknown>)[key], value)
  );
}

const named = (trajectory: Trajectory, name: string): ToolCallRecord[] =>
  trajectory.toolCalls.filter((call) => call.name === name);

/**
 * What the person was left looking at: the final answer and the charts drawn.
 * The harness tells a model that a chart may complete its answer, so numbers
 * that are only in a chart were still given.
 * ponytail: charts from every turn, not only the last. Record a call's turn
 * if a case ever asks about a chart from an earlier one.
 */
const shown = (trajectory: Trajectory): string =>
  `${trajectory.answers.at(-1) ?? ''}\n${charts(trajectory)}`;

/** Everything the charts drawn in a run showed, as text. */
export const charts = (trajectory: Trajectory): string =>
  named(trajectory, 'render_chart')
    .filter((chart) => chart.ok)
    .map((chart) => Object.values(chart.args).join(' '))
    .join('\n');

/** The tool ran at least once, with arguments holding `args` when given. */
export const called = (name: string, args?: Record<string, unknown>): Check => ({
  name: `called ${name}${args ? ` ${JSON.stringify(args)}` : ''}`,
  pass: (t) => named(t, name).some((call) => call.ok && (!args || holds(call.args, args))),
});

/** The tool was never attempted, successfully or not. */
export const notCalled = (name: string): Check => ({
  name: `did not call ${name}`,
  pass: (t) => named(t, name).length === 0,
});

/** Attempts at the tool, whatever came of them, within bounds. */
export const callCount = (name: string, { min = 0, max = Number.POSITIVE_INFINITY }): Check => ({
  name: `${name} attempted ${min}..${max === Number.POSITIVE_INFINITY ? '' : max} times`,
  pass: (t) => named(t, name).length >= min && named(t, name).length <= max,
});

/** At least `count` calls of the tool came from one model call. */
export const calledTogether = (name: string, count: number): Check => ({
  name: `${count} ${name} calls in one turn`,
  pass: (t) => {
    const perStep = Map.groupBy(named(t, name), (call) => call.step);
    return [...perStep.values()].some((calls) => calls.length >= count);
  },
});

/** No failed call was sent again unchanged. */
export const noRepeatedFailedCall = (): Check => ({
  name: 'no failed call repeated unchanged',
  pass: (t) => {
    const failed = t.toolCalls
      .filter((call) => call.error)
      .map((call) => `${call.name} ${JSON.stringify(call.args)}`);
    return new Set(failed).size === failed.length;
  },
});

/** The final answer, or a chart drawn with it, matches. */
export const answered = (pattern: RegExp, name = `answer matches ${pattern}`): Check => ({
  name,
  pass: (t) => pattern.test(shown(t)),
});

/** Neither the final answer nor a chart drawn with it matches. */
export const notAnswered = (pattern: RegExp, name = `answer avoids ${pattern}`): Check => ({
  name,
  pass: (t) => !pattern.test(shown(t)),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Where `after` differs from `before`, as dotted paths. Objects are walked; anything else is compared whole. */
function changedPaths(before: unknown, after: unknown, path = ''): string[] {
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      changedPaths(before[key], after[key], path ? `${path}.${key}` : key)
    );
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
}

/**
 * The world ended as it began, except at `paths` (`tickets.T-17.status`, or
 * `orders` for everything under it). The one rule for a write nobody asked
 * for: a case names what its task may change, and anything else fails it.
 * Whether the allowed changes are the right ones is for the case's own checks.
 */
export const onlyChanged = <S>(world: () => { state: S }, ...paths: string[]): Check<S> => ({
  name: paths.length ? `nothing changed but ${paths.join(', ')}` : 'nothing in the world changed',
  pass: (t) =>
    changedPaths(world().state, t.state).every((changed) =>
      paths.some((allowed) => changed === allowed || changed.startsWith(`${allowed}.`))
    ),
});

/**
 * Every number the final answer gives in the place `pattern` captures is
 * `count`. An answer that gives no number has reported nothing false.
 */
export const reports = (pattern: RegExp, count: number, name: string): Check => ({
  name,
  pass: (t) =>
    [...(t.answers.at(-1) ?? '').matchAll(pattern)].every(
      (match) => Number(match.slice(1).find((group) => group !== undefined)) === count
    ),
});

/** The harness's own tools, which a model can also leak into its answer. */
const HARNESS_TOOLS = ['render_chart', 'spawn_subagent', 'open_tool_group'];

/**
 * No answer carries a tool call as text, or the chat template's own tokens:
 * a call the model meant to make and wrote out instead. Applied to every
 * trial by `grade`.
 */
export const noLeakedCall: Check = {
  name: 'no tool call written into an answer',
  pass: (t) => {
    const names = [...new Set([...HARNESS_TOOLS, ...t.toolCalls.map((call) => call.name)])];
    const leaked = new RegExp(
      // No space allowed before the bracket: "calling list_shipments (from the
      // cursor)" is prose about a tool, not a call.
      `\\b(?:${names.join('|')})[({]|<\\|[^|>\\s]{1,24}\\|>|<tool_code>`
    );
    return !t.answers.some((answer) => leaked.test(answer));
  },
};

/** The world ended as it should have. */
export const state = <S>(name: string, pass: (state: S) => boolean): Check<S> => ({
  name,
  pass: (t) => pass(t.state),
});

/** A structured case's result is what it should be. */
export const output = <T>(name: string, pass: (output: T) => boolean): Check => ({
  name,
  pass: (t) => pass(t.output as T),
});
