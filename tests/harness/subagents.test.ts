/**
 * Subagents, against scripted providers. No network.
 */
import { describe, expect, test } from 'bun:test';
import type { AGUIEvent } from '@ag-ui/core';
import { z } from 'zod';
import { Agent, type AgentTool, type ChatMessage, defineTool } from '../../src/core/index.js';
import { type AutoTurn, Session, SubagentManager } from '../../src/harness/index.js';
import { ScriptedProvider, type Step, call, say } from '../helpers/scripted-provider.js';

const echo = defineTool({
  name: 'echo',
  description: 'Echo the text back.',
  kind: 'read',
  schema: z.object({ text: z.string() }),
  execute: ({ text }) => `echo: ${text}`,
});

const note = defineTool({
  name: 'save_note',
  description: 'Save a note.',
  kind: 'write',
  schema: z.object({ note: z.string() }),
  execute: () => 'saved',
});

/** A manager whose children answer from the given scripts, one per spawn. */
function managerWith(scripts: Step[][], tools: AgentTool[] = [echo, note]) {
  const given: string[][] = [];
  const manager = new SubagentManager({
    tools,
    createSession: (_name, childTools, options) => {
      given.push(childTools.map((t) => t.definition.function.name));
      const provider = new ScriptedProvider('child', scripts.shift() ?? []);
      return new Session(
        new Agent({ routes: [{ client: provider, model: 'm' }], tools: childTools }),
        options
      );
    },
    summarize: async (task, transcript) =>
      `summary of "${task}" from ${transcript.split('\n').length} entries`,
  });
  return { manager, given };
}

describe('SubagentManager', () => {
  test('a subagent runs its task in the background and reports its answer', async () => {
    const { manager, given } = managerWith([[call('echo', { text: 'hi' }), say('Found it.')]]);

    const child = manager.spawn('researcher', 'look it up');
    expect(child).toMatchObject({ id: 'sa-1', status: 'running' });
    expect(given[0]).toEqual(['echo', 'save_note']);

    expect(await manager.wait(manager.select(), 'all', 5_000, new AbortController().signal)).toBe(
      true
    );
    expect(manager.get('sa-1')).toMatchObject({ status: 'done', answer: 'Found it.' });
    const { entries, total } = manager.transcript('sa-1', 0, 10);
    expect(total).toBe(4);
    expect(entries[1]).toContain('call echo');
    expect(await manager.summary('sa-1')).toContain('look it up');
  });

  test('a subagent gets only the tools it is given, and unknown names are refused', () => {
    const { manager, given } = managerWith([[say('ok')]]);
    manager.spawn('narrow', 'task', ['echo']);
    expect(given[0]).toEqual(['echo']);
    expect(() => manager.spawn('bad', 'task', ['spawn_subagent'])).toThrow(
      'Unknown tools spawn_subagent'
    );
  });

  test("a subagent's writes are declined, since nobody can approve them", async () => {
    const { manager } = managerWith([[call('save_note', { note: 'x' }), say('Could not save.')]]);
    manager.spawn('writer', 'save a note');

    await manager.wait(manager.select(), 'all', 5_000, new AbortController().signal);
    const child = manager.get('sa-1');
    expect(child.status).toBe('done');
    expect(child.declined).toHaveLength(1);
    const result = child.session.messages.find((m) => m.role === 'tool');
    expect(String(result?.content)).toContain('unattended');
  });

  test('cancel stops a running subagent; a wait times out without one finishing', async () => {
    const hang: Step = () => new Promise<never>(() => {}) as never;
    const { manager } = managerWith([[hang]]);
    manager.spawn('slow', 'take forever');

    expect(
      await manager.wait(manager.select(['sa-1']), 'all', 20, new AbortController().signal)
    ).toBe(false);
    manager.cancel('sa-1');
    await manager.get('sa-1').settled;
    expect(manager.get('sa-1').status).toBe('cancelled');
  });
});

describe('Subagent tools in the loop', () => {
  test('spawning commits the attempt: a failed route is not replayed', async () => {
    const { manager } = managerWith([[say('child done')]]);
    const first = new ScriptedProvider('first', [
      call('spawn_subagent', { name: 'r', task: 't' }),
      new Error('route broke'),
    ]);
    const second = new ScriptedProvider('second', [say('would spawn again')]);
    const parent = new Agent({
      routes: [
        { client: first, model: 'a' },
        { client: second, model: 'b' },
      ],
      tools: manager.tools(),
    });

    await expect(parent.run('go')).rejects.toThrow('route broke');
    expect(second.calls).toHaveLength(0);
    expect(manager.select()).toHaveLength(1);
  });

  test('waiting on subagents does not spend the parent deadline', async () => {
    const slow: Step = () =>
      new Promise((resolve) => setTimeout(() => resolve(say('slow answer')), 150)) as never;
    const { manager } = managerWith([[slow]]);
    const parent = new Agent({
      routes: [
        {
          client: new ScriptedProvider('parent', [
            call('spawn_subagent', { name: 'r', task: 't' }),
            call('wait_for_subagents', { timeoutSeconds: 5 }),
            say('All done.'),
          ]),
          model: 'm',
        },
      ],
      tools: manager.tools(),
      timeoutMs: 100,
    });

    expect(await parent.run('go')).toBe('All done.');
    expect(manager.get('sa-1').status).toBe('done');
  });
});

describe('Subagent queue', () => {
  test('at most two run at once; the rest queue and start as slots free', async () => {
    const hang: Step = () => new Promise<never>(() => {}) as never;
    const { manager } = managerWith([[hang], [hang], [say('third done')]]);
    manager.spawn('a', 'one');
    manager.spawn('b', 'two');
    const third = manager.spawn('c', 'three');
    expect(third.status).toBe('queued');

    manager.cancel('sa-1');
    await manager.wait([third], 'all', 5_000, new AbortController().signal);
    expect(third).toMatchObject({ status: 'done', answer: 'third done' });
    manager.close();
  });

  test('a subagent cancelled while queued never starts', async () => {
    const hang: Step = () => new Promise<never>(() => {}) as never;
    const { manager, given } = managerWith([[hang], [hang], [say('never')]]);
    manager.spawn('a', 'one');
    manager.spawn('b', 'two');
    const third = manager.spawn('c', 'three');

    manager.cancel(third.id);
    await third.settled;
    expect(third.status).toBe('cancelled');
    expect(given).toHaveLength(3);
    manager.close();
  });
});

const never = new AbortController().signal;
const text = (m: ChatMessage | undefined) => String(m?.content ?? '');

describe('Messaging a subagent', () => {
  test('a finished subagent takes a message up as a new turn of its conversation', async () => {
    const { manager } = managerWith([[say('First answer.'), say('Second answer.')]]);
    const child = manager.spawn('r', 'first task');
    await child.settled;

    manager.message(child.id, 'now the second part');
    expect(child.status).toBe('running');
    await manager.wait([child], 'all', 5_000, never);
    expect(child).toMatchObject({ status: 'done', answer: 'Second answer.' });
    const tasks = child.session.messages.filter((m) => m.role === 'user');
    expect(tasks.map((m) => m.content)).toEqual(['first task', 'now the second part']);
  });

  test('a running subagent reads messages once its current turn ends', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Step = () => gate.then(() => say('First.')) as never;
    const seen: string[] = [];
    const second: Step = (messages) => {
      seen.push(text(messages.at(-1)));
      return say('Both handled.');
    };
    const { manager } = managerWith([[slow, second]]);
    const child = manager.spawn('r', 'task');

    manager.message(child.id, 'also this');
    manager.message(child.id, 'and this');
    release();
    await child.settled;
    expect(child.answer).toBe('Both handled.');
    expect(seen).toEqual(['also this\n\nand this']);
  });
});

describe('Subagent news', () => {
  test('a child that finished unseen is news once; seen or cancelled ones are not', async () => {
    const hang: Step = () => new Promise<never>(() => {}) as never;
    const { manager } = managerWith([[say('A found.')], [say('B found.')], [hang]]);
    const a = manager.spawn('a', 'one');
    const b = manager.spawn('b', 'two');
    await Promise.all([a.settled, b.settled]);
    const c = manager.spawn('c', 'three');

    // The parent's model saw b through a tool.
    await manager
      .tools()
      .find((t) => t.definition.function.name === 'subagent_status')!
      .execute({ id: b.id }, { signal: never, commit: () => {}, untimed: (p) => p });
    manager.cancel(c.id);
    await c.settled;

    const news = manager.takeNews()!;
    expect(news.split('\n')[0]).toBe('Subagents finished: a (sa-1) done.');
    expect(news).toContain('A found.');
    expect(news).not.toContain('B found.');
    expect(manager.takeNews()).toBeUndefined();
  });

  test("a child finishing after the parent's turn starts a parent turn with the news", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Step = () => gate.then(() => say('The answer is 42.')) as never;
    const { manager } = managerWith([[slow]], [echo]);
    const provider = new ScriptedProvider('parent', [
      call('spawn_subagent', { name: 'r', task: 'find it' }),
      say('Started a researcher; I will report back.'),
      say('It is 42.'),
    ]);
    const parent = new Session(
      new Agent({ routes: [{ client: provider, model: 'm' }], tools: manager.tools() }),
      { background: manager }
    );
    const answers: string[] = [];
    const events: AGUIEvent[] = [];
    parent.onAutoTurn((turn: AutoTurn) => {
      turn({ onEvent: (e) => events.push(e) }).then((answer) => answers.push(answer));
    });

    answers.push(await parent.send('what is it?', { onEvent: () => {} }));
    release();
    await parent.idle();

    expect(answers).toEqual(['Started a researcher; I will report back.', 'It is 42.']);
    expect(text(provider.calls[2]?.at(-1))).toContain('The answer is 42.');
    expect(provider.calls[2]?.at(-1)?.origin).toBe('agent');
    const opening = parent.messages.find((m) => m.role === 'developer');
    expect(opening?.content).toStartWith('Subagents finished: r (sa-1) done.');
    expect(events[1]).toMatchObject({ type: 'TEXT_MESSAGE_START', role: 'developer' });
  });

  test('news that arrives while the parent waits on the child is not delivered again', async () => {
    const { manager } = managerWith([[say('Done.')]]);
    const provider = new ScriptedProvider('parent', [
      call('spawn_subagent', { name: 'r', task: 't' }),
      call('wait_for_subagents', {}),
      say('All done.'),
    ]);
    const parent = new Session(
      new Agent({ routes: [{ client: provider, model: 'm' }], tools: manager.tools() }),
      { background: manager }
    );
    let autoTurns = 0;
    parent.onAutoTurn(() => {
      autoTurns++;
    });

    await parent.send('go', { onEvent: () => {} });
    await parent.idle();
    expect(autoTurns).toBe(0);
  });
});
