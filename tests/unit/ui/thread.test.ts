/**
 * Grouping the AG-UI thread into what the message list draws.
 */
import { describe, expect, test } from 'bun:test';
import type { Message } from '@ag-ui/core';
import { threadBubbles } from '../../../src/ui/thread.js';

const thread: Message[] = [
  { id: 'u1', role: 'user', content: 'chart please' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Here you go.',
    toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'render_chart', arguments: '{}' } },
    ],
  },
  { id: 'c1:display', role: 'activity', activityType: 'solenoid.chart', content: {} },
  { id: 'c1:result', role: 'tool', toolCallId: 'c1', content: 'Shown.' },
];
const idle = { streaming: false, showReasoning: false };

describe('threadBubbles', () => {
  test('one reply per user message: text, tool calls with their results, then components', () => {
    const [first, second] = threadBubbles(thread, [], idle);
    expect(first).toEqual({ role: 'user', key: 'u1', text: 'chart please' });
    if (second?.role !== 'assistant') throw new Error('expected a reply');
    expect(second.items.map((i) => i.kind)).toEqual(['text', 'tool', 'activity']);
    expect(second.items[1]).toMatchObject({ result: thread[3] });
  });

  test('items carry the thread’s own message objects, so unchanged rows can be skipped', () => {
    const [, reply] = threadBubbles(thread, [], idle);
    if (reply?.role !== 'assistant') throw new Error('expected a reply');
    const tool = reply.items[1];
    expect(tool?.kind === 'tool' && tool.call).toBe(
      (thread[1] as Extract<Message, { role: 'assistant' }>).toolCalls![0]!
    );
  });

  test('only the last reply streams, and not once a notice follows it', () => {
    const streaming = { streaming: true, showReasoning: false };
    const bubbles = threadBubbles(thread, [], streaming);
    expect(bubbles.at(-1)).toMatchObject({ role: 'assistant', streaming: true });
    const after = threadBubbles(thread, [{ id: 'n', text: 'Interrupted.', at: 4 }], streaming);
    expect(after.map((b) => b.role)).toEqual(['user', 'assistant', 'system']);
    expect(after[1]).toMatchObject({ streaming: false });
  });

  test('notices sit where they were posted', () => {
    const bubbles = threadBubbles(
      thread,
      [
        { id: 'n0', text: 'warning', at: 0 },
        { id: 'n1', text: 'done', at: thread.length },
      ],
      idle
    );
    expect(bubbles.map((b) => b.key)).toEqual(['n0', 'u1', 'a1', 'n1']);
  });
});
