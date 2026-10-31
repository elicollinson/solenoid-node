/**
 * Thread View
 *
 * Groups the AG-UI thread into what MessageList draws: each person's
 * message, then everything the agent produced until the next one as one
 * reply of items (text, a status line per tool call, display components).
 * Notices the app posts sit where in the thread they were posted.
 *
 * Pure, and derived on every render: the items hold the thread's own
 * message objects, which the reducer keeps for every message an event did
 * not touch, so React Compiler's memoization in the row components skips
 * them.
 */
import {
  type ActivityMessage,
  type Message as AgUiMessage,
  type ToolCall as AgUiToolCall,
  type ToolMessage,
  contentToText,
} from '@ag-ui/core';

export interface Notice {
  id: string;
  text: string;
  /** Thread length when it was posted: it is drawn after that many messages. */
  at: number;
}

export type ReplyItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; call: AgUiToolCall; result: ToolMessage | undefined }
  | { kind: 'activity'; key: string; message: ActivityMessage };

export type Bubble =
  | { role: 'user'; key: string; text: string }
  | { role: 'system'; key: string; text: string }
  | {
      role: 'assistant';
      key: string;
      items: ReplyItem[];
      /** The reply in progress: text draws raw with a cursor, unfinished calls are running. */
      streaming: boolean;
      /** The latest reasoning, while the reply streams and display.show_reasoning is on. */
      reasoning?: string;
    };

export interface ViewOptions {
  /** A reply is in progress: the last one streams. */
  streaming: boolean;
  showReasoning: boolean;
}

export function threadBubbles(
  thread: readonly AgUiMessage[],
  notices: readonly Notice[],
  { streaming, showReasoning }: ViewOptions
): Bubble[] {
  const bubbles: Bubble[] = [];
  let reply: AgUiMessage[] = [];
  let next = 0;

  const flushReply = () => {
    if (reply.length) bubbles.push(replyBubble(reply, false, showReasoning));
    reply = [];
  };
  const flushNotices = (upTo: number) => {
    while (next < notices.length && notices[next]!.at <= upTo) {
      flushReply();
      const notice = notices[next++]!;
      bubbles.push({ role: 'system', key: notice.id, text: notice.text });
    }
  };

  thread.forEach((message, index) => {
    flushNotices(index);
    if (message.role === 'user') {
      flushReply();
      bubbles.push({ role: 'user', key: message.id, text: contentToText(message.content) });
    } else if (message.role !== 'system' && message.role !== 'developer') {
      reply.push(message);
    }
  });
  // The last reply streams unless a notice was posted after it.
  const noticeAfter = next < notices.length && notices[next]!.at <= thread.length;
  if (reply.length) bubbles.push(replyBubble(reply, streaming && !noticeAfter, showReasoning));
  reply = [];
  flushNotices(Number.POSITIVE_INFINITY);
  return bubbles;
}

function replyBubble(messages: AgUiMessage[], streaming: boolean, showReasoning: boolean): Bubble {
  const results = new Map<string, ToolMessage>();
  for (const m of messages) if (m.role === 'tool') results.set(m.toolCallId, m);

  const items: ReplyItem[] = [];
  let reasoning: string | undefined;
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.content) items.push({ kind: 'text', key: m.id, text: m.content });
      for (const call of m.toolCalls ?? []) {
        items.push({ kind: 'tool', key: call.id, call, result: results.get(call.id) });
      }
    } else if (m.role === 'activity') {
      items.push({ kind: 'activity', key: m.id, message: m });
    } else if (m.role === 'reasoning') {
      reasoning = m.content;
    }
  }
  return {
    role: 'assistant',
    key: messages[0]!.id,
    items,
    streaming,
    ...(streaming && showReasoning && reasoning ? { reasoning } : {}),
  };
}
