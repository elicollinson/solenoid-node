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
  [
    trajectory.answers.at(-1) ?? '',
    ...named(trajectory, 'render_chart')
      .filter((chart) => chart.ok)
      .map((chart) => Object.values(chart.args).join(' ')),
  ].join('\n');

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
