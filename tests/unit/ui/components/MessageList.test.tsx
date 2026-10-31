/**
 * MessageList Component Tests
 *
 * The list draws an AG-UI thread: labels, streaming text, markdown once a
 * reply is complete, tool status lines, components and notices.
 */
import { describe, expect, it } from 'bun:test';
import type { Message } from '@ag-ui/core';
import { render } from 'ink-testing-library';
import { SOLENOID_METADATA_KEY } from '../../../../src/harness/index.js';
import { MessageList } from '../../../../src/ui/components/MessageList.js';

const user = (id: string, content: string): Message => ({ id, role: 'user', content });
const reply = (id: string, content: string, toolCalls?: string[]): Message => ({
  id,
  role: 'assistant',
  content,
  ...(toolCalls
    ? {
        toolCalls: toolCalls.map((name) => ({
          id: `call-${name}`,
          type: 'function' as const,
          function: { name, arguments: '{}' },
        })),
      }
    : {}),
});
const result = (name: string, extra: Record<string, unknown> = {}): Message =>
  ({
    id: `call-${name}:result`,
    role: 'tool',
    toolCallId: `call-${name}`,
    content: 'ok',
    ...extra,
  }) as Message;

describe('MessageList', () => {
  it('shows the empty state', () => {
    const { lastFrame } = render(<MessageList thread={[]} />);
    expect(lastFrame()).toContain('No messages yet');
  });

  it('labels the person and the agent, in order', () => {
    const { lastFrame } = render(
      <MessageList thread={[user('u1', 'First'), reply('a1', 'Second')]} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain('You');
    expect(frame).toContain('Solenoid');
    expect(frame.indexOf('First')).toBeLessThan(frame.indexOf('Second'));
  });

  it('draws notices as System messages where they were posted', () => {
    const { lastFrame } = render(
      <MessageList
        thread={[user('u1', 'hi'), reply('a1', 'hello')]}
        notices={[{ id: 'n1', text: 'Interrupted.', at: 2 }]}
      />
    );
    const frame = lastFrame()!;
    expect(frame).toContain('System');
    expect(frame.indexOf('hello')).toBeLessThan(frame.indexOf('Interrupted.'));
  });

  it('shows a cursor while the reply streams, and none once it is done', () => {
    const thread = [user('u1', 'hi'), reply('a1', 'Typing')];
    expect(render(<MessageList thread={thread} streaming />).lastFrame()).toContain('▌');
    expect(render(<MessageList thread={thread} />).lastFrame()).not.toContain('▌');
  });

  it('renders markdown once the reply is complete', () => {
    const thread = [user('u1', 'hi'), reply('a1', 'This is **bold** text\n\n- **First** item')];
    const done = render(<MessageList thread={thread} />).lastFrame()!;
    expect(done).toContain('bold');
    expect(done).not.toContain('**');
    expect(render(<MessageList thread={thread} streaming />).lastFrame()).toContain('**bold**');
  });

  it('shows reasoning only while streaming, when asked to', () => {
    const thread: Message[] = [
      user('u1', 'hi'),
      { id: 'r1', role: 'reasoning', content: 'pondering the request' },
      reply('a1', 'Answer'),
    ];
    expect(render(<MessageList thread={thread} streaming showReasoning />).lastFrame()).toContain(
      'pondering the request'
    );
    expect(render(<MessageList thread={thread} streaming />).lastFrame()).not.toContain(
      'pondering'
    );
    expect(render(<MessageList thread={thread} showReasoning />).lastFrame()).not.toContain(
      'pondering'
    );
  });

  it('marks a tool call running, completed or failed', () => {
    const thread: Message[] = [
      user('u1', 'go'),
      reply('a1', 'Working on it.', ['read_webpage', 'universal_search', 'save_note']),
      result('universal_search'),
      result('save_note', { error: 'HTTP 404' }),
    ];
    const frame = render(<MessageList thread={thread} streaming />).lastFrame()!;
    expect(frame).toContain('◐ read_webpage');
    expect(frame).toContain('● universal_search');
    expect(frame).toContain('✗ save_note');
    expect(frame).toContain('HTTP 404');
  });

  it('words declined and quarantined calls, and calls a finished reply never ran', () => {
    const thread: Message[] = [
      user('u1', 'go'),
      reply('a1', '', ['save_note', 'read_webpage', 'universal_search']),
      result('save_note', { metadata: { [SOLENOID_METADATA_KEY]: { declined: true } } }),
      result('read_webpage', { metadata: { [SOLENOID_METADATA_KEY]: { quarantined: true } } }),
    ];
    const frame = render(<MessageList thread={thread} />).lastFrame()!;
    expect(frame).toContain('declined');
    expect(frame).toContain('possible prompt injection');
    expect(frame).toContain('not run');
  });

  it('draws a chart component after the reply text', () => {
    const thread: Message[] = [
      user('u1', 'chart'),
      reply('a1', 'Here it is.', ['render_chart']),
      {
        id: 'call-render_chart:display',
        role: 'activity',
        activityType: 'solenoid.chart',
        content: { chartType: 'bar', title: 'Fruit', data: [{ label: 'Apples', value: 3 }] },
      },
      result('render_chart'),
    ];
    const frame = render(<MessageList thread={thread} />).lastFrame()!;
    expect(frame).toContain('● render_chart');
    expect(frame).toContain('Apples');
    expect(frame.indexOf('Here it is.')).toBeLessThan(frame.indexOf('Apples'));
  });
});
