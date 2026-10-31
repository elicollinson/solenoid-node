/**
 * Message List Component
 *
 * Draws the AG-UI thread: the person's messages, and each agent reply as
 * its text, a status line per tool call, and the components its display
 * tools showed (charts), in the order they arrived. Text streams raw and
 * renders as markdown once the reply is complete. Components are drawn
 * through the catalog (./catalog.tsx).
 */
import type { Message as AgUiMessage, ToolCall as AgUiToolCall, ToolMessage } from '@ag-ui/core';
import { Box, Text } from 'ink';
import { toolStatus } from '../../harness/index.js';
import { type Bubble, type Notice, type ReplyItem, threadBubbles } from '../thread.js';
import { Markdown } from './Markdown.js';
import { ActivityView } from './catalog.js';

interface MessageListProps {
  thread: readonly AgUiMessage[];
  notices?: readonly Notice[];
  /** A reply is in progress. */
  streaming?: boolean;
  showReasoning?: boolean;
}

const roleColors = { user: 'green', assistant: 'cyan', system: 'yellow' } as const;
const roleLabels = { user: 'You', assistant: 'Solenoid', system: 'System' } as const;
const statusIcons = { running: '◐', completed: '●', failed: '✗' } as const;
const statusColors = { running: 'yellow', completed: 'green', failed: 'red' } as const;

/** How much of the streaming reasoning is drawn. */
const REASONING_TAIL_CHARS = 600;

function TextItem({
  text,
  streaming,
  cursor,
}: {
  text: string;
  streaming: boolean;
  cursor: boolean;
}) {
  return (
    <Box paddingLeft={2}>
      {streaming ? (
        <Text wrap="wrap">
          {text}
          {cursor && <Text color="gray">▌</Text>}
        </Text>
      ) : (
        <Markdown>{text}</Markdown>
      )}
    </Box>
  );
}

function ToolItem({
  call,
  result,
  streaming,
}: {
  call: AgUiToolCall;
  result: ToolMessage | undefined;
  streaming: boolean;
}) {
  const outcome = toolStatus(result, { finished: !streaming });
  return (
    <Box paddingLeft={4}>
      <Text color={statusColors[outcome.status]}>
        {statusIcons[outcome.status]} {call.function.name}
      </Text>
      {outcome.status === 'failed' && (
        <Text color="red" dimColor>
          {' '}
          - {outcome.reason}
        </Text>
      )}
    </Box>
  );
}

function ReplyItemView({
  item,
  streaming,
  last,
}: {
  item: ReplyItem;
  streaming: boolean;
  last: boolean;
}) {
  switch (item.kind) {
    case 'text':
      return <TextItem text={item.text} streaming={streaming} cursor={streaming && last} />;
    case 'tool':
      return <ToolItem call={item.call} result={item.result} streaming={streaming} />;
    case 'activity':
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <ActivityView activityType={item.message.activityType} content={item.message.content} />
        </Box>
      );
  }
}

function BubbleView({ bubble }: { bubble: Bubble }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={roleColors[bubble.role]}>
        {roleLabels[bubble.role]}
      </Text>
      {bubble.role === 'assistant' ? (
        <>
          {bubble.reasoning && (
            <Box paddingLeft={2}>
              <Text dimColor italic wrap="wrap">
                {bubble.reasoning.slice(-REASONING_TAIL_CHARS)}
              </Text>
            </Box>
          )}
          {bubble.items.map((item, i) => (
            <ReplyItemView
              key={item.key}
              item={item}
              streaming={bubble.streaming}
              last={i === bubble.items.length - 1}
            />
          ))}
          {bubble.streaming && !bubble.items.length && (
            <Box paddingLeft={2}>
              <Text color="gray">▌</Text>
            </Box>
          )}
        </>
      ) : (
        <TextItem text={bubble.text} streaming={false} cursor={false} />
      )}
    </Box>
  );
}

export function MessageList({
  thread,
  notices = [],
  streaming = false,
  showReasoning = false,
}: MessageListProps) {
  const bubbles = threadBubbles(thread, notices, { streaming, showReasoning });
  if (bubbles.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text dimColor>No messages yet. Type something to get started!</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingY={1}>
      {bubbles.map((bubble) => (
        <BubbleView key={bubble.key} bubble={bubble} />
      ))}
    </Box>
  );
}
