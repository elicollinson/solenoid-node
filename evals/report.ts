/**
 * Report
 *
 * Grades saved trials against the cases as they are written now, and lays
 * the result out as markdown. Nothing here runs a model, so a check or a
 * metric can change and every earlier run be read again.
 */
import type { Message } from '@ag-ui/core';
import { type EvalCase, type Trajectory, featureOf } from './case.js';
import { noLeakedCall } from './checks.js';

/** One trial as saved: a line of a run's JSONL file. */
export interface TrialRecord {
  /** The commit the harness was at; `+dirty` with uncommitted changes. */
  sha: string;
  /** When the trial ended, ISO 8601. */
  at: string;
  case: string;
  /** `provider:model`. */
  model: string;
  /** The run's settings overrides (`--set`). With the model, the condition under test. */
  settings: Record<string, unknown>;
  trial: number;
  /** Seconds a turn was allowed before it was cut off. Absent on trials saved before it was recorded. */
  limit?: number;
  trajectory: Trajectory;
  /** The conversation as a client holds it: every message, call and result in full. */
  thread: Message[];
}

/** What a trial ran under: its model, and any settings the run changed. */
export const conditionOf = (record: Pick<TrialRecord, 'model' | 'settings'>): string =>
  Object.keys(record.settings).length
    ? `${record.model} ${JSON.stringify(record.settings)}`
    : record.model;

/** Which trial of a run a record is. Run again under the same key, it is skipped. */
export const trialKey = (record: Pick<TrialRecord, 'model' | 'settings' | 'case' | 'trial'>) =>
  `${conditionOf(record)} ${record.case} ${record.trial}`;

/**
 * Model calls that produced neither a tool call nor an answer, which the
 * agent loop answers with a silent "continue": every call of a trial either
 * made tool calls, ended a turn, or was one of these. A trial can pass after
 * several, so they are counted apart from the grade.
 * ponytail: derived, since saved trials carry no event for it. A run that
 * died mid-call is allowed one such call; emit an event if that guess is ever wrong.
 */
export function nudges(trajectory: Trajectory): number {
  const acting = new Set(trajectory.toolCalls.map((call) => call.step)).size;
  // A structured run ends on submit_result, a turn of its own with no answer text.
  const ending = trajectory.answers.length || (trajectory.output === undefined ? 0 : 1);
  return Math.max(0, trajectory.modelCalls - acting - ending - (trajectory.error ? 1 : 0));
}

/** The names of the checks a trial failed; none means it passed. */
export function grade(evalCase: EvalCase, trajectory: Trajectory): string[] {
  const failed = [...evalCase.checks, noLeakedCall]
    .filter((check) => {
      try {
        return !check.pass(trajectory);
      } catch {
        return true;
      }
    })
    .map((check) => check.name);
  return trajectory.error ? ['completed', ...failed] : failed;
}

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const mean = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const rate = (passed: boolean[]): string =>
  passed.length ? `${passed.filter(Boolean).length}/${passed.length}` : '-';

export function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

/**
 * `more` names what failed a trial beyond its checks: the judge's flips
 * (./judge.ts), which only ever turn a passing trial into a failing one.
 */
export function report(
  records: TrialRecord[],
  cases: EvalCase[],
  more: (record: TrialRecord) => string[] = () => []
): string {
  const byId = new Map(cases.map((evalCase) => [evalCase.id, evalCase]));
  const trials = records.flatMap((record) => {
    const evalCase = byId.get(record.case);
    if (!evalCase) return [];
    // Only a trial that passes its checks can be failed for more.
    const checks = grade(evalCase, record.trajectory);
    const failed = checks.length ? checks : more(record);
    return [
      { ...record, evalCase, condition: conditionOf(record), failed, passed: !failed.length },
    ];
  });
  type Trial = (typeof trials)[number];
  const conditions = unique(trials.map((trial) => trial.condition));
  const passes = (some: Trial[]) => rate(some.map((trial) => trial.passed));
  /** A table row: `label`, then how many of `some` passed under each condition. */
  const row = (label: string, some: Trial[]) => [
    label,
    ...conditions.map((condition) => passes(some.filter((t) => t.condition === condition))),
  ];

  const orphans = records.length - trials.length;
  const parts = [
    '# Eval report',
    `${trials.length} trials. Harness at ${unique(trials.map((trial) => trial.sha)).join(', ')}.${
      orphans ? ` ${orphans} trials of cases that no longer exist were left out.` : ''
    }`,
  ];

  const fixed = trials.filter((trial) => !trial.evalCase.sweep);
  const features = Map.groupBy(fixed, (trial) => featureOf(trial.case));
  if (features.size) {
    // A case every trial passes separates models in nothing but cost, and one
    // no trial passes may be a broken case: only those between rank anything.
    const perCase = [...Map.groupBy(fixed, (trial) => trial.case)];
    const none = perCase.filter(([, some]) => !some.some((trial) => trial.passed));
    const all = perCase.filter(([, some]) => some.every((trial) => trial.passed));
    parts.push(
      `Of ${perCase.length} fixed cases, ${all.length} passed every trial under every condition and ${none.length} passed none.${
        none.length
          ? ` Check a case nothing passes before blaming a model: ${none.map(([id]) => id).join(', ')}.`
          : ''
      }`
    );
    parts.push(
      '## Trials passed, by feature',
      table(
        ['feature', ...conditions],
        [...[...features].map(([feature, some]) => row(feature, some)), row('**all**', fixed)]
      )
    );
  }

  const sweeps = Map.groupBy(
    trials.filter((trial) => trial.evalCase.sweep),
    (trial) => trial.evalCase.sweep!.id
  );
  if (sweeps.size) parts.push('## Limits: trials passed at each size');
  for (const [id, some] of sweeps) {
    const sizes = Map.groupBy(some, (trial) => trial.evalCase.sweep!.size);
    const ordered = [...sizes.keys()].sort((a, b) => a - b);
    parts.push(
      table(
        [id, ...ordered.map(String), 'holds to'],
        conditions.map((condition) => {
          const at = ordered.map((size) => ({
            size,
            passed: sizes
              .get(size)!
              .filter((trial) => trial.condition === condition)
              .map((trial) => trial.passed),
          }));
          // Holds to the largest size before one where under half the trials passed, of the sizes run.
          const ran = at.filter(({ passed }) => passed.length);
          const broke = ran.findIndex(
            ({ passed }) => passed.filter(Boolean).length * 2 < passed.length
          );
          const held = broke < 0 ? ran.at(-1) : ran[broke - 1];
          return [
            condition,
            ...at.map(({ passed }) => rate(passed)),
            held ? `${held.size}${broke < 0 ? '+' : ''}` : '-',
          ];
        })
      )
    );
  }

  const under = Map.groupBy(trials, (trial) => trial.condition);
  /** The fewest model calls any passing trial of a case took, under any condition. */
  const best = new Map(
    [
      ...Map.groupBy(
        trials.filter((trial) => trial.passed),
        (trial) => trial.case
      ),
    ].map(([id, some]) => [id, Math.min(...some.map((trial) => trial.trajectory.modelCalls))])
  );
  const average = (some: Trial[], read: (trajectory: Trajectory) => number, digits = 1) =>
    mean(some.map((trial) => read(trial.trajectory))).toFixed(digits);
  parts.push(
    '## Per trial, on average',
    table(
      [
        '',
        'model calls',
        'over best',
        'tool calls',
        'failed',
        'malformed',
        'nudged',
        'tokens in',
        'tokens out',
        'of them reasoning',
        'seconds',
      ],
      [...under].map(([condition, some]) => [
        condition,
        average(some, (t) => t.modelCalls),
        // Seconds depend on what else the server is doing; wasted calls do not.
        mean(
          some
            .filter((trial) => trial.passed)
            .map((trial) => trial.trajectory.modelCalls - best.get(trial.case)!)
        ).toFixed(2),
        average(some, (t) => t.toolCalls.length),
        average(some, (t) => t.toolCalls.filter((call) => call.error).length, 2),
        average(some, (t) => t.toolCalls.filter((call) => call.malformed).length, 2),
        average(some, nudges, 2),
        average(some, (t) => t.tokens.input, 0),
        average(some, (t) => t.tokens.output, 0),
        average(some, (t) => t.tokens.reasoning, 0),
        average(some, (t) => t.durationMs / 1000),
      ])
    )
  );

  const failing = [...under].flatMap(([condition, ofCondition]) =>
    [...Map.groupBy(ofCondition, (trial) => trial.case)].flatMap(([id, some]) => {
      const counts = Map.groupBy(
        some.flatMap((trial) => trial.failed),
        (name) => name
      );
      if (!counts.size) return [];
      const why = [...counts].map(([name, hits]) => `${name} (${hits.length})`).join('; ');
      // How far each failing trial got: a run that stops at call 5 of 64 did not fail on length.
      const reached = some
        .filter((trial) => !trial.passed)
        .map((trial) => trial.trajectory.toolCalls.length)
        .join(', ');
      return [[condition, id, passes(some), why, reached]];
    })
  );
  if (failing.length) {
    parts.push(
      '## Failing cases',
      table(
        ['', 'case', 'passed', 'checks failed', 'tool calls made by each failing trial'],
        failing
      )
    );
  }
  return parts.join('\n\n');
}
