/**
 * The eval suite's own tests. No real model: the runner is driven through
 * the real harness against a scripted OpenAI-compatible server.
 *
 * Live evals never run in CI, so the first test here is what keeps a case
 * from rotting when the harness changes under it.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type EvalCase, type Trajectory, defineCase, profileOf, sweep } from '../../evals/case.js';
import { answered, called, output, state } from '../../evals/checks.js';
import { type TrialRecord, grade, report } from '../../evals/report.js';
import { loadCases, runTrial } from '../../evals/run.js';
import { type TicketsState, tickets } from '../../evals/worlds/tickets.js';
import { AppSettingsSchema, createHarness } from '../../src/index.js';
import {
  type FakeModelServer,
  type Script,
  fakeModelServer,
  lastOf,
} from '../helpers/fake-model-server.js';
import { call, say } from '../helpers/scripted-provider.js';

/** The server of the last trial, for what it was sent. */
let server: FakeModelServer | undefined;

/** Run `evalCase` on a model that answers from `script`. */
const trial = (evalCase: EvalCase, script: Script) => {
  const model = fakeModelServer(script);
  server = model;
  return runTrial(evalCase, 'lmstudio:scripted', {
    providers: { lmstudio: { base_url: model.baseUrl } },
  }).finally(() => model.stop());
};

/** Calls `name` once, then answers with what it returned. */
const callThenAnswer =
  (name: string, args: unknown): Script =>
  (request) =>
    request.messages.at(-1)?.role === 'tool' ? say(lastOf(request, 'tool')) : call(name, args);

describe('every eval case', () => {
  test('has a unique id and opens against the harness as it is now', async () => {
    const cases = await loadCases();
    expect(cases.length).toBeGreaterThan(0);
    const harness = await createHarness(
      AppSettingsSchema.parse({ screening: { enabled: false }, search: { provider: 'none' } })
    );
    try {
      for (const evalCase of cases) {
        const world = evalCase.world();
        // Throws on a tool name clash, a bad group or an unknown exclusion.
        expect(() => harness.createSession(profileOf(evalCase, world)), evalCase.id).not.toThrow();
        expect(() => structuredClone(world.state), evalCase.id).not.toThrow();
        expect(evalCase.checks.length, evalCase.id).toBeGreaterThan(0);
      }
    } finally {
      await harness.close();
    }
  });

  // A case no run can pass, or whose checks refuse a right answer, would read
  // as a model's failure. Playing a known right run back rules both out.
  test('with a reference run passes when that run is played back', async () => {
    const referenced = (await loadCases()).filter((evalCase) => evalCase.reference);
    expect(referenced.length).toBeGreaterThan(0);
    for (const evalCase of referenced) {
      const replies = [...evalCase.reference!];
      const { trajectory } = await trial(
        evalCase,
        () => replies.shift() ?? say('The reference ran out.')
      );
      expect(grade(evalCase, trajectory), evalCase.id).toEqual([]);
      expect(trajectory.modelCalls, evalCase.id).toBe(evalCase.reference!.length);
    }
  }, 60_000);

  // And a case that passes when nothing is done measures nothing.
  test('fails a model that does nothing', async () => {
    for (const evalCase of await loadCases()) {
      const { trajectory } = await trial(evalCase, () => say('Done.'));
      expect(grade(evalCase, trajectory), evalCase.id).not.toEqual([]);
    }
  }, 60_000);
});

describe('runTrial', () => {
  const closeAcme = defineCase({
    id: 'test/close',
    world: tickets,
    turns: ['Close T-17 as a duplicate.'],
    checks: [
      called('close_ticket', { id: 'T-17' }),
      state<TicketsState>('T-17 closed', (s) => s.tickets['T-17']!.status === 'closed'),
      answered(/Closed T-17/),
    ],
  });
  const closeIt = callThenAnswer('close_ticket', { id: 'T-17', resolution: 'duplicate' });

  test('records the calls, the answer, the cost and the world as it ended', async () => {
    const { trajectory, thread } = await trial(closeAcme, closeIt);

    expect(trajectory.error).toBeUndefined();
    expect(trajectory.answers).toEqual(['Closed T-17.']);
    expect(trajectory.toolCalls).toEqual([
      {
        name: 'close_ticket',
        args: { id: 'T-17', resolution: 'duplicate' },
        step: 1,
        ok: true,
        output: 'Closed T-17.',
      },
    ]);
    expect(trajectory.modelCalls).toBe(2);
    expect(trajectory.tokens).toEqual({ input: 20, output: 10, reasoning: 0 });
    expect((trajectory.state as TicketsState).tickets['T-17']).toMatchObject({
      status: 'closed',
      resolution: 'duplicate',
    });
    expect(thread.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(grade(closeAcme, trajectory)).toEqual([]);
    // The fixture world is all a case reaches: of the base tools only the
    // chart is offered, and never one that reads the live web.
    expect(server?.requests[0]?.tools).toEqual([
      'render_chart',
      'search_tickets',
      'get_ticket',
      'close_ticket',
      'add_note',
    ]);
  });

  test('a declined write is recorded as declined and leaves the world alone', async () => {
    const { trajectory } = await trial({ ...closeAcme, approve: 'deny' }, closeIt);

    expect(trajectory.toolCalls[0]).toMatchObject({ ok: false, declined: true });
    expect((trajectory.state as TicketsState).tickets['T-17']!.status).toBe('open');
    expect(grade(closeAcme, trajectory)).toEqual([
      'called close_ticket {"id":"T-17"}',
      'T-17 closed',
      'answer matches /Closed T-17/',
    ]);
  });

  test('a call the schema refuses is a failed call the model sees, not a failed run', async () => {
    const { trajectory } = await trial(closeAcme, callThenAnswer('close_ticket', { id: 17 }));

    expect(trajectory.error).toBeUndefined();
    expect(trajectory.toolCalls[0]).toMatchObject({ ok: false, malformed: true, args: { id: 17 } });
  });

  test('a run that ends in an error is a result, with the case’s own settings applied', async () => {
    // Two turns allowed and a model that only ever calls tools: it calls one
    // on its last turn, which fails the run.
    const { trajectory } = await trial(
      { ...closeAcme, settings: { agent: { max_turns: 2 } } },
      () => call('get_ticket', { id: 'T-17' })
    );

    expect(trajectory.error).toContain('last turn');
    expect(grade(closeAcme, trajectory)[0]).toBe('completed');
  });

  /** Run `closeAcme` on a server that answers every request with `fetch`. */
  const against = (fetch: () => Response | Promise<Response>, limitMs?: number) => {
    const model = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch });
    const overrides = {
      providers: { lmstudio: { base_url: `http://127.0.0.1:${model.port}/v1` } },
    };
    // Not awaited: a server holding a request that never ends is slow to report itself stopped.
    return runTrial(closeAcme, 'lmstudio:scripted', overrides, limitMs).finally(() => {
      model.stop(true);
    });
  };

  test('a run the server fails is thrown, not recorded as the model’s', async () => {
    const run = against(() =>
      Response.json({ error: { message: 'No models loaded.' } }, { status: 400 })
    );
    await expect(run).rejects.toThrow('No models loaded');
  });

  test('a turn still going at the time limit is cut off and is the model’s failure', async () => {
    const { trajectory } = await against(() => new Promise<Response>(() => {}), 50);
    expect(trajectory.error).toContain('no answer within');
    expect(grade(closeAcme, trajectory)[0]).toBe('completed');
  });

  test('a structured case returns its validated object through the same collector', async () => {
    const schema = z.object({ id: z.string(), open: z.boolean() });
    const structured = defineCase({
      id: 'test/structured',
      world: tickets,
      schema,
      turns: ['Fill in the record for T-18.'],
      checks: [
        called('get_ticket'),
        output<z.infer<typeof schema>>('is T-18, open', (o) => o.id === 'T-18' && o.open),
      ],
    });
    const { trajectory } = await trial(structured, (request) =>
      request.messages.at(-1)?.role === 'tool'
        ? call('submit_result', { id: 'T-18', open: true })
        : call('get_ticket', { id: 'T-18' })
    );

    expect(trajectory.output).toEqual({ id: 'T-18', open: true });
    expect(trajectory.toolCalls.map((c) => c.name)).toEqual(['get_ticket']);
    expect(trajectory.modelCalls).toBe(2);
    expect(grade(structured, trajectory)).toEqual([]);
    expect(server?.requests[0]?.tools).toContain('submit_result');
  });

  test('a parent that spawns a subagent is run until the news turn has answered', async () => {
    const delegating = defineCase({
      id: 'test/subagent',
      world: tickets,
      profile: (world) => ({ tools: world.tools, canSpawn: true }),
      turns: ['Have a subagent read T-18.'],
      checks: [called('spawn_subagent'), answered(/it said: T-18 is open/)],
    });
    const { trajectory } = await trial(delegating, (request) => {
      if (lastOf(request, 'system').includes('You are a subagent')) return say('T-18 is open');
      if (request.messages.at(-1)?.role === 'tool') return say('One is running.');
      return lastOf(request, 'user').includes('T-18 is open')
        ? say('it said: T-18 is open')
        : call('spawn_subagent', {
            name: 'reader',
            task: 'Read ticket T-18 and report its status.',
          });
    });

    expect(trajectory.error).toBeUndefined();
    expect(trajectory.answers).toEqual(['One is running.', 'it said: T-18 is open']);
    expect(grade(delegating, trajectory)).toEqual([]);
  });
});

describe('checks', () => {
  test('a chart drawn as the answer is read like one', () => {
    const charted = {
      answers: [''],
      toolCalls: [{ name: 'render_chart', ok: true, args: { barData: '[{"value":130}]' } }],
    } as unknown as Trajectory;
    expect(answered(/130/).pass(charted)).toBe(true);
    expect(answered(/45/).pass(charted)).toBe(false);
  });

  test('“couldn’t” and “no email capability” say it cannot', async () => {
    const cannot = (await loadCases()).find((c) => c.id === 'decisions/says-what-it-cannot-do')!;
    const said = {
      answers: ['I couldn’t send the email: there is no email capability here.'],
      toolCalls: [],
      state: tickets().state,
    } as unknown as Trajectory;
    expect(grade(cannot, said)).toEqual([]);
  });
});

describe('report', () => {
  const evalCase = defineCase({
    id: 'feature/case',
    world: tickets,
    turns: ['?'],
    checks: [answered(/yes/)],
  });
  const record = (model: string, trial: number, answer: string): TrialRecord => ({
    sha: 'abc1234',
    at: '2026-11-21T00:00:00.000Z',
    case: evalCase.id,
    model,
    settings: {},
    trial,
    thread: [],
    trajectory: {
      answers: [answer],
      toolCalls: [],
      modelCalls: 1,
      retries: 0,
      tokens: { input: 100, output: 20, reasoning: 0 },
      durationMs: 1500,
      state: {},
    },
  });

  test('grades saved trials against the cases as written now, per model', () => {
    const wandering = record('lmstudio:a', 3, 'yes');
    wandering.trajectory.modelCalls = 3;
    const text = report(
      [
        record('lmstudio:a', 1, 'yes'),
        record('lmstudio:a', 2, 'no'),
        wandering,
        record('openrouter:b', 1, 'yes'),
        { ...record('openrouter:b', 2, 'yes'), case: 'feature/removed' },
      ],
      [evalCase]
    );

    expect(text).toContain(
      'Of 1 fixed cases, 0 passed every trial under every condition and 0 passed none.'
    );
    expect(text).toContain('| feature | 2/3 | 1/1 |');
    expect(text).toContain('| lmstudio:a | feature/case | 2/3 | answer matches /yes/ (1) |');
    // Passing trials took 1 and 3 model calls: one wasted call each, on average.
    expect(text).toContain('| lmstudio:a | 1.7 | 1.00 |');
    expect(text).toContain('1 trials of cases that no longer exist were left out');
  });

  test('a sweep is a table of its own, one column per size, and stays out of the features', () => {
    const [small, large] = sweep('limits/size', [5, 20], () => ({
      world: tickets,
      turns: ['?'],
      checks: [answered(/yes/)],
    }));
    const at = (evalCase: EvalCase, model: string, answer: string): TrialRecord => ({
      ...record(model, 1, answer),
      case: evalCase.id,
    });
    const text = report(
      [
        at(large!, 'lmstudio:a', 'no'),
        at(small!, 'lmstudio:a', 'yes'),
        at(small!, 'openrouter:b', 'yes'),
        at(large!, 'openrouter:b', 'yes'),
      ],
      [small!, large!]
    );

    expect(text).toContain('| limits/size | 5 | 20 | holds to |');
    expect(text).toContain('| lmstudio:a | 1/1 | 0/1 | 5 |');
    expect(text).toContain('| openrouter:b | 1/1 | 1/1 | 20+ |');
    expect(text).not.toContain('by feature');
  });
});
