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

    await manager.idle();
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

    await manager.idle();
    const child = manager.get('sa-1');
    expect(child.status).toBe('done');
    expect(child.declined).toHaveLength(1);
    const result = child.session.messages.find((m) => m.role === 'tool');
    expect(String(result?.content)).toContain('unattended');
  });

  test('the same task while it is under way is the same subagent', () => {
    const hang: Step = () => new Promise<never>(() => {}) as never;
    const { manager, given } = managerWith([[hang]]);
    const first = manager.spawn('r', 'look it up');
    expect(manager.spawn('r again', 'look it up')).toBe(first);
    expect(given).toHaveLength(1);
    manager.close();
  });

  test('a running subagent cannot be read, only a finished one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager } = managerWith([[() => gate.then(() => say('Done.')) as never]]);
    const child = manager.spawn('r', 'task');
    expect(() => manager.transcript(child.id, 0, 10)).toThrow('sa-1 is still running');
    await expect(manager.summary(child.id)).rejects.toThrow('You will get a message from it');
    release();
    await child.settled;
    expect(manager.transcript(child.id, 0, 10).entries[0]).toBe('[0] task: task');
  });

  test('cancel stops a running subagent', async () => {
    const hang: Step = () => new Promise<never>(() => {}) as never;
    const { manager } = managerWith([[hang]]);
    manager.spawn('slow', 'take forever');

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
    await third.settled;
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

const text = (m: ChatMessage | undefined) => String(m?.content ?? '');

describe('Messaging a subagent', () => {
  test('a finished subagent takes a message up as a new turn of its conversation', async () => {
    const { manager } = managerWith([[say('First answer.'), say('Second answer.')]]);
    const child = manager.spawn('r', 'first task');
    await child.settled;

    manager.message(child.id, 'now the second part');
    expect(child.status).toBe('running');
    await child.settled;
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
  test('every child that resolves sends one message; a cancelled one sends none', async () => {
    const hang: Step = () => new Promise<never>(() => {}) as never;
    const { manager } = managerWith([[say('A found.')], [say('')], [hang]]);
    const a = manager.spawn('a', 'one');
    const b = manager.spawn('b', 'two');
    await Promise.all([a.settled, b.settled]);
    const c = manager.spawn('c', 'three');
    manager.cancel(c.id);
    await c.settled;

    const news = manager.takeNews()!;
    expect(news.split('\n')[0]).toBe('Subagents finished: a (sa-1) done, b (sa-2) done.');
    expect(news).toContain('A found.');
    expect(news).toContain('b (sa-2) answered:\nNothing to report.');
    expect(news).not.toContain('(sa-3)');
    expect(manager.takeNews()).toBeUndefined();
  });

  test('status lists every child while any runs, and nothing once all have resolved', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager } = managerWith([[say('Quick.')], [() => gate.then(() => say('Slow.')) as never]]);
    const quick = manager.spawn('quick', 'one');
    manager.spawn('slow', 'two');
    await quick.settled;

    const status = manager.status()!;
    expect(status).toContain('- sa-1 quick: done');
    expect(status).toContain('- sa-2 slow: running');
    release();
    await manager.idle();
    expect(manager.status()).toBeUndefined();
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

  test('the parent orchestrates: it ends its turn, and hears from each child with the status of the rest', async () => {
    const gates = [0, 1].map(() => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    });
    const { manager } = managerWith([
      [() => gates[0]!.promise.then(() => say('A is 1.')) as never],
      [() => gates[1]!.promise.then(() => say('B is 2.')) as never],
    ]);
    const provider = new ScriptedProvider('parent', [
      call('spawn_subagent', { name: 'a', task: 'find a' }),
      call('spawn_subagent', { name: 'b', task: 'find b' }),
      say('Two researchers are on it.'),
      say('A is back; waiting on B.'),
      say('A is 1 and B is 2.'),
    ]);
    const parent = new Session(
      new Agent({ routes: [{ client: provider, model: 'm' }], tools: manager.tools() }),
      { background: manager }
    );
    const answers: string[] = [];
    parent.onAutoTurn((turn) => {
      turn({ onEvent: () => {} }).then((answer) => answers.push(answer));
    });

    answers.push(await parent.send('find a and b', { onEvent: () => {} }));
    gates[0]!.release();
    while (answers.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    const afterA = text(provider.calls[3]?.at(-1));
    expect(afterA).toContain('a (sa-1) answered:\nA is 1.');
    expect(afterA).toContain('- sa-2 b: running');
    gates[1]!.release();
    await parent.idle();

    expect(answers).toEqual([
      'Two researchers are on it.',
      'A is back; waiting on B.',
      'A is 1 and B is 2.',
    ]);
    // Nothing is running once B resolves, so its message has no status block.
    expect(text(provider.calls[4]?.at(-1))).not.toContain('Status of your subagents');
    // The thread shows the person's words alone.
    expect(parent.messages.find((m) => m.role === 'user')?.content).toBe('find a and b');
  });
});
