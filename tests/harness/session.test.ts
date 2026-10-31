/**
 * The session's AG-UI stream, against a scripted provider. No network.
 */
import { describe, expect, test } from 'bun:test';
import { type AGUIEvent, EventType } from '@ag-ui/core';
import { z } from 'zod';
import { Agent, defineTool } from '../../src/core/index.js';
import { APPROVAL_REASON, Session, applyEvent } from '../../src/harness/index.js';
import { renderChartTool } from '../../src/tools/index.js';
import { ScriptedProvider, call, say } from '../helpers/scripted-provider.js';

function writeTool(log: string[]) {
  return defineTool({
    name: 'save_note',
    description: 'Save a note.',
    kind: 'write',
    schema: z.object({ note: z.string() }),
    execute: ({ note }) => {
      log.push(note);
      return 'saved';
    },
  });
}

const types = (events: AGUIEvent[]) => events.map((e) => e.type);

describe('Session (AG-UI)', () => {
  test('a turn is one run: start, step, text, finish', async () => {
    const provider = new ScriptedProvider('fake', [say('Hello')]);
    const session = new Session(new Agent({ routes: [{ client: provider, model: 'm' }] }));
    const events: AGUIEvent[] = [];

    await session.send('hi', { onEvent: (e) => events.push(e) });

    expect(types(events)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.STEP_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.STEP_FINISHED,
      EventType.RUN_FINISHED,
    ]);
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'success' } });
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  test('a client folding the events builds the thread the session holds', async () => {
    const chartArgs = {
      chartType: 'bar',
      barData: JSON.stringify([{ label: 'A', value: 1 }]),
      done: true,
    };
    const provider = new ScriptedProvider('fake', [
      {
        role: 'assistant',
        content: 'Chart below.',
        toolCalls: [{ id: 'c1', name: 'render_chart', arguments: chartArgs }],
      },
    ]);
    const session = new Session(
      new Agent({ routes: [{ client: provider, model: 'm' }], tools: [renderChartTool] })
    );
    let client: ReturnType<typeof applyEvent> = [];

    await session.send('chart', {
      onEvent: (e) => {
        client = applyEvent(client, e);
      },
    });

    expect(client).toEqual([...session.messages]);
    const activity = client.find((m) => m.role === 'activity');
    expect(activity).toMatchObject({
      activityType: 'solenoid.chart',
      content: { chartType: 'bar', data: [{ label: 'A', value: 1 }] },
    });
    // Answer and chart in one turn: one model call, nothing drawn twice.
    expect(provider.calls).toHaveLength(1);
    expect(client.filter((m) => m.role === 'activity')).toHaveLength(1);
  });

  test('a route change sends a snapshot without the abandoned attempt', async () => {
    const first = new ScriptedProvider('first', [
      (_m, opts) => {
        opts.onDelta?.({ type: 'text', text: 'partial' });
        throw new Error('boom');
      },
    ]);
    const second = new ScriptedProvider('second', [say('fallback')]);
    const session = new Session(
      new Agent({
        routes: [
          { client: first, model: 'a' },
          { client: second, model: 'b' },
        ],
      })
    );
    const events: AGUIEvent[] = [];

    await session.send('go', { onEvent: (e) => events.push(e) });

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT);
    expect(snapshot).toMatchObject({ messages: [{ role: 'user', content: 'go' }] });
    const text = session.messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(text).toEqual(['fallback']);
  });

  test('an approval ends the run with an interrupt; resuming runs the write in a new run', async () => {
    const log: string[] = [];
    const provider = new ScriptedProvider('fake', [
      call('save_note', { note: 'x' }, 'w1'),
      say('Saved.'),
    ]);
    const session = new Session(
      new Agent({ routes: [{ client: provider, model: 'm' }], tools: [writeTool(log)] })
    );
    const events: AGUIEvent[] = [];

    const done = session.send('save x', {
      onEvent: (e) => {
        events.push(e);
        if (e.type === EventType.RUN_FINISHED && e.outcome?.type === 'interrupt') {
          const [interrupt] = e.outcome.interrupts;
          expect(interrupt).toMatchObject({ reason: APPROVAL_REASON, toolCallId: 'w1' });
          expect(log).toEqual([]);
          session.resume([
            { interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } },
          ]);
        }
      },
    });

    expect(await done).toBe('Saved.');
    expect(log).toEqual(['x']);
    const runs = events.filter((e) => e.type === EventType.RUN_STARTED);
    expect(runs).toHaveLength(2);
    const finishes = events.filter((e) => e.type === EventType.RUN_FINISHED);
    expect(finishes.map((e) => e.type === EventType.RUN_FINISHED && e.outcome?.type)).toEqual([
      'interrupt',
      'success',
    ]);
  });

  test('a declined or unanswered approval runs nothing and says why', async () => {
    for (const [status, expected] of [
      ['resolved', 'The user declined save_note.'],
      ['cancelled', 'save_note needs approval and this run is unattended'],
    ] as const) {
      const log: string[] = [];
      const provider = new ScriptedProvider('fake', [call('save_note', { note: 'x' }), say('ok')]);
      const session = new Session(
        new Agent({ routes: [{ client: provider, model: 'm' }], tools: [writeTool(log)] })
      );

      await session.send('save', {
        onEvent: (e) => {
          if (e.type === EventType.RUN_FINISHED && e.outcome?.type === 'interrupt') {
            session.resume([
              {
                interruptId: e.outcome.interrupts[0]!.id,
                status,
                ...(status === 'resolved' ? { payload: { approved: false } } : {}),
              },
            ]);
          }
        },
      });

      expect(log).toEqual([]);
      expect(provider.calls[1]!.find((m) => m.role === 'tool')?.content).toContain(expected);
    }
  });

  test('a failed run reports RUN_ERROR and rejects', async () => {
    const provider = new ScriptedProvider('fake', [new Error('model is down')]);
    const session = new Session(new Agent({ routes: [{ client: provider, model: 'm' }] }));
    const events: AGUIEvent[] = [];

    await expect(session.send('hi', { onEvent: (e) => events.push(e) })).rejects.toThrow(
      'model is down'
    );
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: 'model is down' });
  });

  test('a call still running when the turn is stopped is answered as not run', async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: 'slow_read',
      description: 'A read that never finishes.',
      kind: 'read',
      schema: z.object({}),
      execute: () => {
        controller.abort();
        return new Promise(() => {});
      },
    });
    const provider = new ScriptedProvider('fake', [call('slow_read', {}, 's1')]);
    const session = new Session(
      new Agent({ routes: [{ client: provider, model: 'm' }], tools: [slow] })
    );

    await expect(
      session.send('go', { signal: controller.signal, onEvent: () => {} })
    ).rejects.toThrow();
    const result = session.messages.find((m) => m.role === 'tool');
    expect(result).toMatchObject({ toolCallId: 's1', error: 'not run' });
  });

  test('an interrupted run finishes cancelled', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider('fake', [
      () => {
        controller.abort();
        throw new Error('aborted');
      },
    ]);
    const session = new Session(new Agent({ routes: [{ client: provider, model: 'm' }] }));
    const events: AGUIEvent[] = [];

    await expect(
      session.send('hi', { signal: controller.signal, onEvent: (e) => events.push(e) })
    ).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
    });
  });

  test('a send while a turn runs waits for it to end', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const provider = new ScriptedProvider('fake', [
      () => gate.then(() => say('first')) as never,
      say('second'),
    ]);
    const session = new Session(new Agent({ routes: [{ client: provider, model: 'm' }] }));
    const first = session.send('one', { onEvent: () => {} });
    const second = session.send('two', { onEvent: () => {} });
    release();
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    // The second turn began after the first ended: its model call saw the first reply.
    expect(provider.calls[1]?.map((m) => m.content)).toEqual(['one', 'first', 'two']);
  });
});
