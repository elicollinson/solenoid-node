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
import {
  type Message as AgUiMessage,
  type ToolCall as AgUiToolCall,
  type ToolMessage,
  contentToText,
} from '@ag-ui/core';
import { parseToolArgs, toolStatus } from '../harness/index.js';
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

export type ThreadView = (
  thread: readonly AgUiMessage[],
  notices: readonly Notice[],
  options: ViewOptions
) => Message[];

/** A view with its own cache of built bubbles; make a new one to drop it. */
export function createThreadView(): ThreadView {
  const bubbles = new Map<string, { refs: AgUiMessage[]; streaming: boolean; bubble: Message }>();
  const calls = new WeakMap<AgUiToolCall, { result?: ToolMessage; view: ToolCall }>();

  const toolCallView = (
    call: AgUiToolCall,
    result: ToolMessage | undefined,
    streaming: boolean
  ) => {
    const cached = calls.get(call);
    if (cached && cached.result === result && (result || streaming)) return cached.view;
    const outcome = toolStatus(result);
    const base = {
      id: call.id,
      name: call.function.name,
      args: parseToolArgs(call.function.arguments),
    };
    const view: ToolCall =
      outcome.status === 'running'
        ? // No result and the reply is over: the run stopped before this call ended.
          streaming
          ? { ...base, status: 'running' }
          : { ...base, status: 'error', result: 'not run' }
        : outcome.status === 'failed'
          ? { ...base, status: 'error', result: outcome.reason }
          : { ...base, status: 'completed' };
    calls.set(call, { result, view });
    return view;
  };

  const agentBubble = (group: AgUiMessage[], streaming: boolean): Message => {
    const id = group[0]!.id;
    const cached = bubbles.get(id);
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
      content: '',
      parts,
      isStreaming: streaming,
      ...(streaming && reasoning ? { reasoning } : {}),
    };
    bubbles.set(id, { refs: group, streaming, bubble });
    return bubble;
  };

  return (thread, notices, { streaming, showReasoning }) => {
    const view: Message[] = [];
    let group: AgUiMessage[] = [];
    let noticeIndex = 0;

    const flushGroup = (last: boolean) => {
      if (!group.length) return;
      view.push(agentBubble(group, streaming && last));
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
        view.push({ id: message.id, role: 'user', content: contentToText(message.content) });
      } else if (message.role === 'reasoning' && !showReasoning) {
        // Hidden reasoning stays out of the bubble, so its tokens rebuild nothing.
      } else if (message.role !== 'system' && message.role !== 'developer') {
        group.push(message);
      }
    });
    const hasLaterNotices = notices.slice(noticeIndex).some((n) => n.at <= thread.length);
    flushGroup(!hasLaterNotices);
    flushNotices(Number.POSITIVE_INFINITY);
    return view;
  };
}
