/**
 * The terminal's view of an AG-UI thread.
 */
import { describe, expect, test } from 'bun:test';
import type { Message } from '@ag-ui/core';
import { SOLENOID_METADATA_KEY } from '../../../src/harness/index.js';
import { type ViewCache, toView } from '../../../src/ui/thread.js';

const thread: Message[] = [
  { id: 'u1', role: 'user', content: 'chart please' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Here you go.',
    toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'render_chart', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'read_webpage', arguments: '{"url":"x"}' } },
    ],
  },
  { id: 'c1:display', role: 'activity', activityType: 'solenoid.chart', content: { chartType: 'bar' } },
  { id: 'c1:result', role: 'tool', toolCallId: 'c1', content: 'Shown to the person in the chat.' },
  {
    id: 'c2:result',
    role: 'tool',
    toolCallId: 'c2',
    content: 'Error: HTTP 404',
    error: 'HTTP 404',
    metadata: { [SOLENOID_METADATA_KEY]: { error: 'HTTP 404' } },
  },
];

describe('toView', () => {
  test('one reply per user message: text, tool status lines, then components', () => {
    const view = toView(thread, [], { streaming: false, showReasoning: false }, new Map());

    expect(view.map((m) => m.role)).toEqual(['user', 'assistant']);
    const parts = view[1]!.parts!;
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool_call', 'tool_call', 'activity']);
    expect(parts[1]).toMatchObject({ toolCall: { name: 'render_chart', status: 'completed' } });
    expect(parts[2]).toMatchObject({
      toolCall: { name: 'read_webpage', status: 'error', result: 'HTTP 404' },
    });
    expect(parts[3]).toMatchObject({ activityType: 'solenoid.chart' });
  });

  test('a call with no result is running while the reply streams', () => {
    const open = thread.slice(0, 2);
    const view = toView(open, [], { streaming: true, showReasoning: false }, new Map());
    expect(view[1]!.parts![1]).toMatchObject({ toolCall: { status: 'running' } });
    expect(view[1]!.isStreaming).toBe(true);
  });

  test('notices sit where they were posted', () => {
    const view = toView(
      thread,
      [
        { id: 'n0', text: 'warning', at: 0 },
        { id: 'n1', text: 'done', at: thread.length },
      ],
      { streaming: false, showReasoning: false },
      new Map()
    );
    expect(view.map((m) => m.id)).toEqual(['n0', 'u1', 'a1', 'n1']);
  });

  test('an unchanged reply is the same object, so a memoized bubble skips rendering', () => {
    const cache: ViewCache = new Map();
    const options = { streaming: false, showReasoning: false };
    const first = toView(thread, [], options, cache);
    const next = [...thread, { id: 'u2', role: 'user' as const, content: 'again' }];
    const second = toView(next, [], options, cache);
    expect(second[1]).toBe(first[1]!);
  });
});
