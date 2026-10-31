/**
 * AG-UI Reducer
 *
 * The client half of the contract: folds one AG-UI event into a thread of
 * AG-UI messages and returns the new thread. Pure and renderer-free, so the
 * terminal UI holds its conversation in React state with it, the session
 * tracks what it has sent with it, and a web client can use it unchanged.
 *
 * Messages an event does not touch keep their identity, which lets a
 * renderer skip them. Events that carry no message content (lifecycle,
 * steps, custom) leave the thread as it is.
 */
import {
  type AGUIEvent,
  type ActivityMessage,
  type AssistantMessage,
  EventType,
  type Message,
  type ReasoningMessage,
  type ToolMessage,
} from '@ag-ui/core';

/** Where Solenoid keeps its own fields in AG-UI metadata. */
export const SOLENOID_METADATA_KEY = 'solenoid';

/** What a tool result's metadata says beyond its content. */
export interface ToolResultMetadata {
  /** The plain failure message, when the call failed. */
  error?: string;
  /** The output was withheld because the injection screen flagged it. */
  quarantined?: boolean;
  /** No call was made: the person declined it. */
  declined?: boolean;
  durationMs?: number;
}

export function toolResultMetadata(message: ToolMessage): ToolResultMetadata {
  return (message.metadata?.[SOLENOID_METADATA_KEY] as ToolResultMetadata | undefined) ?? {};
}

export function applyEvent(thread: readonly Message[], event: AGUIEvent): Message[] {
  switch (event.type) {
    case EventType.MESSAGES_SNAPSHOT:
      return [...event.messages];

    case EventType.TEXT_MESSAGE_START:
      return upsert(thread, event.messageId, (existing) =>
        existing?.role === 'assistant'
          ? existing
          : { id: event.messageId, role: 'assistant', content: '' }
      );

    case EventType.TEXT_MESSAGE_CONTENT:
      return update(thread, event.messageId, (m) =>
        m.role === 'assistant' ? { ...m, content: (m.content ?? '') + event.delta } : m
      );

    case EventType.REASONING_MESSAGE_START:
      return upsert(
        thread,
        event.messageId,
        (existing) =>
          (existing as ReasoningMessage | undefined) ?? {
            id: event.messageId,
            role: 'reasoning',
            content: '',
          }
      );

    case EventType.REASONING_MESSAGE_CONTENT:
      return update(thread, event.messageId, (m) =>
        m.role === 'reasoning' ? { ...m, content: m.content + event.delta } : m
      );

    case EventType.TOOL_CALL_START: {
      const call = {
        id: event.toolCallId,
        type: 'function' as const,
        function: { name: event.toolCallName, arguments: '' },
      };
      const parentId = event.parentMessageId ?? event.toolCallId;
      return upsert(thread, parentId, (existing) => {
        const parent: AssistantMessage =
          existing?.role === 'assistant' ? existing : { id: parentId, role: 'assistant' };
        return { ...parent, toolCalls: [...(parent.toolCalls ?? []), call] };
      });
    }

    case EventType.TOOL_CALL_ARGS:
      return mapToolCall(thread, event.toolCallId, (call) => ({
        ...call,
        function: { ...call.function, arguments: call.function.arguments + event.delta },
      }));

    case EventType.TOOL_CALL_RESULT: {
      const meta = event.metadata?.[SOLENOID_METADATA_KEY] as ToolResultMetadata | undefined;
      const result: ToolMessage = {
        id: event.messageId,
        role: 'tool',
        toolCallId: event.toolCallId,
        content: event.content,
        ...(meta?.error ? { error: meta.error } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {}),
      };
      return upsert(thread, event.messageId, () => result);
    }

    case EventType.ACTIVITY_SNAPSHOT:
      return upsert(thread, event.messageId, (existing) => {
        const content =
          existing?.role === 'activity' && event.replace === false
            ? { ...existing.content, ...event.content }
            : event.content;
        const activity: ActivityMessage = {
          id: event.messageId,
          role: 'activity',
          activityType: event.activityType,
          content,
        };
        return activity;
      });

    default:
      return thread as Message[];
  }
}

/** Replace the message with this id, or append it when there is none. */
function upsert(
  thread: readonly Message[],
  id: string,
  build: (existing: Message | undefined) => Message
): Message[] {
  const index = thread.findIndex((m) => m.id === id);
  if (index === -1) return [...thread, build(undefined)];
  const next = [...thread];
  next[index] = build(thread[index]);
  return next;
}

/** Change the message with this id; a missing one leaves the thread as it is. */
function update(
  thread: readonly Message[],
  id: string,
  change: (message: Message) => Message
): Message[] {
  const index = thread.findIndex((m) => m.id === id);
  if (index === -1) return thread as Message[];
  const next = [...thread];
  next[index] = change(thread[index]!);
  return next;
}

type ToolCallEntry = NonNullable<AssistantMessage['toolCalls']>[number];

function mapToolCall(
  thread: readonly Message[],
  toolCallId: string,
  change: (call: ToolCallEntry) => ToolCallEntry
): Message[] {
  const index = thread.findIndex(
    (m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === toolCallId)
  );
  if (index === -1) return thread as Message[];
  const parent = thread[index] as AssistantMessage;
  const next = [...thread];
  next[index] = {
    ...parent,
    toolCalls: parent.toolCalls!.map((c) => (c.id === toolCallId ? change(c) : c)),
  };
  return next;
}
