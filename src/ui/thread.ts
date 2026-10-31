/**
 * Thread View
 *
 * Turns the AG-UI thread the app holds into the bubbles MessageList draws:
 * each person's message, then everything the agent produced until the next
 * one (text, a status line per tool call, display components) as one reply.
 * Notices the app posts (startup warnings, run errors) sit at the point in
 * the thread where they were posted.
 *
 * A bubble whose messages are unchanged is returned as the same object, so
 * memoized bubbles skip re-rendering while a reply streams.
 */
import type { Message as AgUiMessage, ToolMessage } from '@ag-ui/core';
import { toolResultMetadata } from '../harness/index.js';
import type { Message, MessagePart, ToolCall } from './components/index.js';

export interface Notice {
  id: string;
  text: string;
  /** Thread length when it was posted: it is drawn after that many messages. */
  at: number;
}

export interface ViewOptions {
  /** A reply is in progress: the last bubble streams. */
  streaming: boolean;
  showReasoning: boolean;
}

interface CachedBubble {
  refs: readonly AgUiMessage[];
  streaming: boolean;
  bubble: Message;
}

export type ViewCache = Map<string, CachedBubble>;

export function toView(
  thread: readonly AgUiMessage[],
  notices: readonly Notice[],
  options: ViewOptions,
  cache: ViewCache
): Message[] {
  const view: Message[] = [];
  let group: AgUiMessage[] = [];
  let noticeIndex = 0;

  const flushGroup = (last: boolean) => {
    if (!group.length) return;
    view.push(agentBubble(group, options.streaming && last, options.showReasoning, cache));
    group = [];
  };
  const flushNotices = (upTo: number) => {
    while (noticeIndex < notices.length && notices[noticeIndex]!.at <= upTo) {
      flushGroup(false);
      const notice = notices[noticeIndex++]!;
      view.push({ id: notice.id, role: 'system', content: notice.text });
    }
  };

  thread.forEach((message, index) => {
    flushNotices(index);
    if (message.role === 'user') {
      flushGroup(false);
      const content = typeof message.content === 'string' ? message.content : '';
      view.push({ id: message.id, role: 'user', content });
    } else if (message.role !== 'system' && message.role !== 'developer') {
      group.push(message);
    }
  });
  const hasLaterNotices = notices.slice(noticeIndex).some((n) => n.at <= thread.length);
  flushGroup(!hasLaterNotices);
  flushNotices(Number.POSITIVE_INFINITY);
  return view;
}

function agentBubble(
  group: AgUiMessage[],
  streaming: boolean,
  showReasoning: boolean,
  cache: ViewCache
): Message {
  const id = group[0]!.id;
  const cached = cache.get(id);
  if (
    cached &&
    cached.streaming === streaming &&
    cached.refs.length === group.length &&
    cached.refs.every((ref, i) => ref === group[i])
  ) {
    return cached.bubble;
  }

  const results = new Map<string, ToolMessage>();
  for (const message of group) {
    if (message.role === 'tool') results.set(message.toolCallId, message);
  }

  const parts: MessagePart[] = [];
  let reasoning: string | undefined;
  for (const message of group) {
    if (message.role === 'assistant') {
      if (message.content) parts.push({ type: 'text', content: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({
          type: 'tool_call',
          toolCall: toolCallView(call, results.get(call.id), streaming),
        });
      }
    } else if (message.role === 'activity') {
      parts.push({
        type: 'activity',
        id: message.id,
        activityType: message.activityType,
        content: message.content,
      });
    } else if (message.role === 'reasoning') {
      reasoning = message.content;
    }
  }

  const bubble: Message = {
    id,
    role: 'assistant',
    content: parts
      .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.content)
      .join(''),
    parts,
    isStreaming: streaming,
    ...(streaming && showReasoning && reasoning ? { reasoning } : {}),
  };
  cache.set(id, { refs: [...group], streaming, bubble });
  return bubble;
}

function toolCallView(
  call: { id: string; function: { name: string; arguments: string } },
  result: ToolMessage | undefined,
  streaming: boolean
): ToolCall {
  const base = { id: call.id, name: call.function.name, args: parseArgs(call.function.arguments) };
  if (!result) {
    // No result and the reply is over: the run stopped before this call ended.
    return streaming
      ? { ...base, status: 'running' }
      : { ...base, status: 'error', result: 'not run' };
  }
  const meta = toolResultMetadata(result);
  if (meta.quarantined) {
    return { ...base, status: 'error', result: 'output blocked: possible prompt injection' };
  }
  if (meta.declined) return { ...base, status: 'error', result: 'declined' };
  if (result.error) return { ...base, status: 'error', result: result.error };
  return { ...base, status: 'completed' };
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json || '{}');
    return value && typeof value === 'object' ? value : { value };
  } catch {
    return { raw: json };
  }
}
