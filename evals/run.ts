/**
 * Eval Runner
 *
 * Runs eval cases (./cases) on real models through the real harness and
 * saves every trial, then prints the report.
 *
 *   bun run eval --model lmstudio:google/gemma-4-26b-a4b
 *   bun run eval --model openrouter:google/gemma-4-26b-a4b-it --model lmstudio:... --trials 5
 *   bun run eval --model ... --filter recovery --set agent.think=low
 *   OMLX_BASE_URL=https://host:port/v1 bun run eval --model omlx:<id>
 *   bun run eval --report evals/runs/<file>.jsonl      # grade again, no model calls
 *   bun run eval --judge evals/runs/<file>.jsonl       # fail passing trials for what they said
 *
 * Each trial gets a harness of its own, built from settings made here: one
 * route and no fallback, so a failure is the model's; screening off, so the
 * judge is not part of the score; no search and no MCP servers. `--set`
 * changes any of it for the run (`--set screening.enabled=true`, or
 * `--set providers.lmstudio.base_url=...` for another OpenAI-compatible
 * server), and a case's own `settings` come last. A server's address can come
 * from LMSTUDIO_BASE_URL or OMLX_BASE_URL instead, which keeps it out of the
 * saved run: `--set` is recorded with every trial, the environment is not.
 *
 * Sampling is the server's default and cannot be pinned, so each case runs
 * `--trials` times and is reported as a rate. A run appends to its `--out`
 * file and skips what the file already holds: run the same command again to
 * resume one that was stopped.
 *
 * `--judge` puts each passing trial of a saved run to the judge (./judge.ts)
 * and what the judge questions to a reviewer, which can fail the trial. It
 * needs ANTHROPIC_API_KEY, and keeps both answers beside the run. Every
 * report of that run then counts them.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  AgentAbortedError,
  type AgentProfile,
  AgentRunError,
  type AppSettings,
  AppSettingsSchema,
  PromptInjectionDetectedError,
  createHarness,
  declinedMessage,
  describeRunError,
  generateSettings,
} from '../src/index.js';
import { type EvalCase, profileOf } from './case.js';
import {
  anthropicJudge,
  anthropicReviewer,
  flips,
  judgeFile,
  judgeReport,
  judgeRun,
  readJudged,
  readReviewed,
  reviewFile,
  reviewRun,
} from './judge.js';
import { type TrialRecord, grade, report, trialKey } from './report.js';
import { collector } from './trajectory.js';

type Overrides = Record<string, unknown>;

const isRecord = (value: unknown): value is Overrides =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function merge(base: Overrides, over: Overrides): Overrides {
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const had = merged[key];
    merged[key] = isRecord(had) && isRecord(value) ? merge(had, value) : value;
  }
  return merged;
}

/** The settings a trial's harness is built from: the eval defaults, then each of `overrides`. */
function trialSettings(model: string, ...overrides: Overrides[]): AppSettings {
  const colon = model.indexOf(':');
  if (colon < 1) throw new Error(`--model takes provider:model, got "${model}"`);
  const defaults: Overrides = {
    routes: [{ provider: model.slice(0, colon), model: model.slice(colon + 1) }],
    screening: { enabled: false },
    search: { provider: 'none' },
  };
  const fromEnv = generateSettings({ baseSettings: defaults, onlySetEnvVars: true });
  return AppSettingsSchema.parse(overrides.reduce(merge, fromEnv as Overrides));
}

/** Every case under ./cases: each file's default export is an array of them. */
export async function loadCases(): Promise<EvalCase[]> {
  const dir = join(import.meta.dir, 'cases');
  const files = [...new Bun.Glob('*.ts').scanSync(dir)].sort();
  const cases = (
    await Promise.all(files.map(async (file) => (await import(join(dir, file))).default))
  ).flat() as EvalCase[];
  const ids = new Set<string>();
  for (const { id } of cases) {
    if (ids.has(id)) throw new Error(`Two eval cases share the id ${id}`);
    ids.add(id);
  }
  return cases;
}

/**
 * Run one case once on `model`, under the run's settings `overrides` and then
 * the case's own, and say what happened. A run the model fails is a result,
 * not an error: it comes back in `trajectory.error`. A run the server fails
 * (unreachable, no model loaded, gone quiet) says nothing about the model
 * and is thrown.
 * ponytail: a server that refuses a conversation too long for its context is
 * thrown too, though that is a limit worth recording. Tell the two apart by
 * the server's message if a sweep ever reaches it.
 * A turn still going after `limitMs` is cut off and is the model's failure:
 * the stall guard ends a silent server first, so a turn that reaches the
 * limit was being answered the whole time, by a model that never finished.
 * The limit is each turn's, since a long conversation is not a slow answer.
 * ponytail: the limit is wall-clock time, so a server busy with other work
 * can trip it on a healthy turn. Count output tokens instead if that happens.
 */
export async function runTrial(
  evalCase: EvalCase,
  model: string,
  overrides: Overrides = {},
  limitMs = 10 * 60_000
): Promise<Pick<TrialRecord, 'trajectory' | 'thread'>> {
  const settings = trialSettings(model, overrides, evalCase.settings ?? {});
  const world = evalCase.world();
  const own = profileOf(evalCase, world);
  const allows = evalCase.approve === 'deny' ? () => false : (evalCase.approve ?? (() => true));
  const profile: AgentProfile = {
    approve: (request) =>
      allows(request.tool, request.args as Record<string, unknown>)
        ? { allow: true }
        : { allow: false, tell: declinedMessage(request.tool, 'declined') },
    ...own,
  };

  const harness = await createHarness(settings);
  const seen = collector();
  const { onEvent } = seen;
  const answers: string[] = [];
  let output: unknown;
  let error: string | undefined;
  let serverFailure: unknown;
  const limited = () => ({ onEvent, signal: AbortSignal.timeout(limitMs) });
  const fail = (cause: unknown) => {
    // The limit is the only signal a trial passes, so an interrupted run reached it.
    const late = cause instanceof AgentAbortedError;
    const models =
      late || cause instanceof AgentRunError || cause instanceof PromptInjectionDetectedError;
    if (!models) serverFailure ??= cause;
    error ??= late
      ? `no answer within ${Math.round(limitMs / 1000)} seconds`
      : describeRunError(cause);
  };
  const started = performance.now();
  try {
    if (evalCase.schema) {
      output = await harness.runStructured(evalCase.turns[0]!, evalCase.schema, {
        profile,
        ...limited(),
      });
    } else {
      const session = harness.createSession(profile);
      // A turn the session starts itself, when a subagent has news.
      session.onAutoTurn((turn) => {
        turn(limited()).then((answer) => answers.push(answer), fail);
      });
      for (const text of evalCase.turns) answers.push(await session.send(text, limited()));
      await session.idle();
    }
  } catch (cause) {
    fail(cause);
  } finally {
    await harness.close();
  }
  if (serverFailure) throw serverFailure;

  const { thread, ...observed } = seen.observed();
  return {
    trajectory: {
      answers,
      output,
      error,
      ...observed,
      durationMs: Math.round(performance.now() - started),
      state: structuredClone(world.state),
    },
    thread,
  };
}

const readRecords = (file: string): TrialRecord[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrialRecord);

/** The harness commit a run measured, so two runs of one suite can be told apart. */
function harnessSha(): string {
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', ...args], { cwd: import.meta.dir })
      .stdout.toString()
      .trim();
  const sha = git('rev-parse', '--short', 'HEAD');
  return sha ? `${sha}${git('status', '--porcelain') ? '+dirty' : ''}` : 'unknown';
}

/**
 * `agent.think=low` as `{ agent: { think: 'low' } }`; the value is read as
 * YAML. Overrides are saved with every trial and printed in the report, so
 * the places a settings file keeps secrets are refused here.
 */
function parseSet(pair: string): Overrides {
  const equals = pair.indexOf('=');
  if (equals < 1) throw new Error(`--set takes path=value, got "${pair}"`);
  if (/api_key|(^|\.)(env|headers)(\.|$)/.test(pair.slice(0, equals))) {
    throw new Error(
      `--set ${pair.slice(0, equals)}: overrides are saved with the run. Pass secrets through the environment.`
    );
  }
  const value: unknown = parseYaml(pair.slice(equals + 1));
  const path = pair.slice(0, equals).split('.');
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Overrides;
}

const USAGE = `Usage: bun run eval --model provider:model [--model ...] [options]
       bun run eval --report <run.jsonl>
       bun run eval --judge <run.jsonl> [--concurrency n]

  --model        A model to run, as lmstudio:<id>, omlx:<id> or openrouter:<id>. Repeatable.
  --trials       Runs of each case per model (default 3).
  --filter       Only cases whose id contains this.
  --set          A settings override for the run, as path=value. Repeatable.
  --out          The run's JSONL file (default evals/runs/<time>.jsonl). An existing file is resumed.
  --concurrency  Trials at once (default 1; a local server has one model to share).
  --limit        Seconds before a turn still running is cut off and fails its trial (default 600).
  --report       Print the report for a saved run and exit, making no model calls.
  --judge        Have a judge and a reviewer read what the passing trials of a saved run said, then print its report.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', multiple: true, default: [] },
      trials: { type: 'string', default: '3' },
      filter: { type: 'string', default: '' },
      set: { type: 'string', multiple: true, default: [] },
      out: { type: 'string' },
      concurrency: { type: 'string', default: '1' },
      limit: { type: 'string', default: '600' },
      report: { type: 'string' },
      judge: { type: 'string' },
    },
  });
  const cases = (await loadCases()).filter((evalCase) => evalCase.id.includes(values.filter));

  /** A saved run's report, with what the judge found if it has been judged. */
  const reportOf = (file: string) => {
    const records = readRecords(file);
    const judged = readJudged(judgeFile(file));
    const reviewed = readReviewed(reviewFile(file));
    return [
      report(records, cases, flips(judged, reviewed)),
      judgeReport(records, cases, judged, reviewed),
    ]
      .filter(Boolean)
      .join('\n\n');
  };
  if (values.judge) {
    const records = readRecords(values.judge);
    const concurrency = Number(values.concurrency);
    const judging = await judgeRun(
      records,
      cases,
      judgeFile(values.judge),
      anthropicJudge(),
      concurrency
    );
    const reviewing = await reviewRun(
      records,
      cases,
      readJudged(judgeFile(values.judge)),
      reviewFile(values.judge),
      anthropicReviewer(),
      concurrency
    );
    console.log(reportOf(values.judge));
    const errors = judging.errors + reviewing.errors;
    if (errors) {
      console.error(
        `${judging.errors} trials were not judged and ${reviewing.errors} raised questions not reviewed. Run the same command again for them.`
      );
    }
    return errors ? 1 : 0;
  }
  if (values.report) {
    console.log(reportOf(values.report));
    return 0;
  }
  if (!values.model.length || !cases.length) {
    console.error(cases.length ? USAGE : `No case id contains "${values.filter}".`);
    return 1;
  }

  const overrides = values.set.map(parseSet).reduce(merge, {});
  const limitMs = Number(values.limit) * 1000;
  const out =
    values.out ??
    join(import.meta.dir, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  mkdirSync(dirname(out), { recursive: true });
  const done = new Set(existsSync(out) ? readRecords(out).map(trialKey) : []);

  const sha = harnessSha();
  const jobs = values.model.flatMap((model) =>
    cases.flatMap((evalCase) =>
      Array.from({ length: Number(values.trials) }, (_, index) => ({
        evalCase,
        model,
        trial: index + 1,
      }))
    )
  );
  const todo = jobs.filter(
    (job) => !done.has(trialKey({ ...job, case: job.evalCase.id, settings: overrides }))
  );
  console.error(`${todo.length} trials to run (${jobs.length - todo.length} already in ${out})`);

  let notRun = 0;
  const work = async () => {
    for (let job = todo.shift(); job; job = todo.shift()) {
      const { evalCase, model, trial } = job;
      // Not saved, so running the same command again runs it.
      const ran = await runTrial(evalCase, model, overrides, limitMs).catch((cause) => {
        notRun++;
        console.error(`! ${model} ${evalCase.id} #${trial} not run: ${describeRunError(cause)}`);
      });
      if (!ran) continue;
      const record: TrialRecord = {
        sha,
        case: evalCase.id,
        model,
        settings: overrides,
        trial,
        limit: limitMs / 1000,
        ...ran,
        at: new Date().toISOString(),
      };
      appendFileSync(out, `${JSON.stringify(record)}\n`);
      const failed = grade(evalCase, record.trajectory);
      console.error(
        `${failed.length ? '✗' : '✓'} ${model} ${evalCase.id} #${trial} (${(
          record.trajectory.durationMs / 1000
        ).toFixed(1)}s)${failed.length ? `: ${failed.join('; ')}` : ''}`
      );
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, work));

  console.log(reportOf(out));
  console.error(`\nSaved to ${out}`);
  if (notRun) {
    console.error(
      `${notRun} trials were not run because the model server failed. Run the same command again for them.`
    );
  }
  return notRun ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
