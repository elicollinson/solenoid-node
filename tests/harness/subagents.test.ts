/**
 * Subagents, against scripted providers. No network.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { Agent, type AgentTool, defineTool } from '../../src/core/index.js';
import { Session, SubagentManager } from '../../src/harness/index.js';
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
    createSession: (_name, childTools) => {
      given.push(childTools.map((t) => t.definition.function.name));
      const provider = new ScriptedProvider('child', scripts.shift() ?? []);
      return new Session(new Agent({ routes: [{ client: provider, model: 'm' }], tools: childTools }));
    },
    summarize: async (task, transcript) => `summary of "${task}" from ${transcript.split('\n').length} entries`,
  });
  return { manager, given };
}

describe('SubagentManager', () => {
  test('a subagent runs its task in the background and reports its answer', async () => {
    const { manager, given } = managerWith([[call('echo', { text: 'hi' }), say('Found it.')]]);

    const child = manager.spawn('researcher', 'look it up');
    expect(child).toMatchObject({ id: 'sa-1', status: 'running' });
    expect(given[0]).toEqual(['echo', 'save_note']);

    expect(await manager.wait(undefined, 'all', 5_000)).toBe(true);
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

    await manager.wait(undefined, 'all', 5_000);
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

    expect(await manager.wait(['sa-1'], 'all', 20)).toBe(false);
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
    expect(manager.list()).toHaveLength(1);
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
