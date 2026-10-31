/**
 * Message List Component
 *
 * Renders the conversation: the person's messages, and each agent reply as
 * its text, a status line per tool call, and the components its display
 * tools showed (charts, tables), in the order they arrived. Text streams raw
 * and renders as markdown once complete.
 *
 * The list is a view of the AG-UI thread (see ../thread.ts); components are
 * drawn through the catalog (./catalog.tsx).
 */
import { Box, Text } from 'ink';
import { memo } from 'react';
import { Markdown } from './Markdown.js';
import { ActivityView } from './catalog.js';

export interface ToolCall {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  result?: string;
  args?: Record<string, unknown>;
}

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  /** A display component: `activityType` picks it from the catalog. */
  | { type: 'activity'; id: string; activityType: string; content: Record<string, unknown> };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  isStreaming?: boolean;
  parts?: MessagePart[];
  /** The model's reasoning for the turn in progress, when display.show_reasoning is on. */
  reasoning?: string;
  wasInterrupted?: boolean;
}

interface MessageListProps {
  messages: Message[];
  maxHeight?: number;
}

const statusIcons = {
  running: '◐',
  completed: '●',
  error: '✗',
} as const;

const roleColors = { user: 'green', assistant: 'cyan', system: 'yellow' } as const;
const roleLabels = { user: 'You', assistant: 'Solenoid', system: 'System' } as const;

const statusColors = {
  running: 'yellow',
  completed: 'green',
  error: 'red',
} as const;

function ToolCallDisplay({ toolCall }: { toolCall: ToolCall }) {
  return (
    <Box paddingLeft={4} marginY={0}>
      <Text color={statusColors[toolCall.status]}>
        {statusIcons[toolCall.status]} {toolCall.name}
      </Text>
      {toolCall.result && toolCall.status === 'error' && (
        <Text color="red" dimColor>
          {' '}
          - {toolCall.result}
        </Text>
      )}
    </Box>
  );
}

// Memoized: a streaming delta replaces only the message in progress, so
// finished messages (and their charts) are not re-rendered per token.
const MessageBubble = memo(function MessageBubble({ message }: { message: Message }) {
  const label = roleLabels[message.role];

  // Render text content - raw while streaming, markdown when complete
  const renderTextContent = (content: string, isStreaming: boolean, showCursor: boolean) => {
    if (isStreaming || !content) {
      // Raw text while streaming to avoid markdown parsing overhead
      return (
        <Text wrap="wrap">
          {content}
          {showCursor && <Text color="gray">▌</Text>}
        </Text>
      );
    }
    // Render as markdown when complete
    return <Markdown>{content}</Markdown>;
  };

  // Render interleaved parts if available
  const renderParts = () => {
    if (!message.parts || message.parts.length === 0) {
      // Fallback to simple content
      if (!message.content) return null;
      return (
        <Box paddingLeft={2}>
          {renderTextContent(message.content, !!message.isStreaming, !!message.isStreaming)}
        </Box>
      );
    }

    return message.parts.map((part, index) => {
      if (part.type === 'text') {
        const isLast = index === message.parts!.length - 1;
        const showCursor = isLast && !!message.isStreaming;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: text parts are append-only and never reorder
          <Box key={`text-${index}`} paddingLeft={2}>
            {renderTextContent(part.content, !!message.isStreaming, showCursor)}
          </Box>
        );
      }
      if (part.type === 'activity') {
        return (
          <Box key={part.id} flexDirection="column" paddingLeft={2}>
            <ActivityView activityType={part.activityType} content={part.content} />
          </Box>
        );
      }
      return <ToolCallDisplay key={part.toolCall.id} toolCall={part.toolCall} />;
    });
  };

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={roleColors[message.role]}>
        {label}
      </Text>
      {message.isStreaming && message.reasoning && (
        <Box paddingLeft={2}>
          <Text dimColor italic wrap="wrap">
            {message.reasoning.slice(-600)}
          </Text>
        </Box>
      )}
      {renderParts()}
      {!message.isStreaming && message.wasInterrupted && (
        <Box paddingLeft={2}>
          <Text dimColor italic>
            -- interrupted --
          </Text>
        </Box>
      )}
    </Box>
  );
});

export function MessageList({ messages, maxHeight }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text dimColor>No messages yet. Type something to get started!</Text>
      </Box>
    );
  }

  const displayMessages = maxHeight ? messages.slice(-maxHeight) : messages;

  return (
    <Box flexDirection="column" paddingY={1}>
      {displayMessages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </Box>
  );
}
