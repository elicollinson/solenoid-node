/**
 * Message List Component
 *
 * Renders the chat conversation history with support for streaming responses,
 * tool call indicators, markdown formatting, and inline chart rendering.
 * Messages display differently based on role (user, assistant, system) with
 * distinct colors and labels.
 *
 * Charts render inline from render_chart tool call arguments, at the point
 * in the message flow where the tool was called.
 *
 * Dependencies:
 * - marked: Markdown parser for formatting completed responses
 * - marked-terminal: Terminal-friendly renderer for markdown output
 * - ChartRenderer: Inline chart rendering component
 */
import { Box, Text } from 'ink';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { memo, useMemo } from 'react';
import { getArtifact } from '../../artifacts/index.js';
import { ChartRenderer, isChartToolCall } from './ChartRenderer.js';

// Configure marked with terminal renderer.
// Patch: marked-terminal v7.3.0's text renderer returns raw text instead of
// parsing inline tokens, so bold/italic inside list items shows as raw markdown.
const ext = markedTerminal({
  reflowText: true,
  width: process.stdout.columns || 80,
});
const origText = ext.renderer!.text!;
// biome-ignore lint/suspicious/noExplicitAny: marked-terminal v7 types don't expose renderer internals
ext.renderer!.text = function (this: any, token: any) {
  if (token?.tokens) return this.parser.parseInline(token.tokens);
  return origText.call(this, token);
};
marked.use(ext);

function renderMarkdown(content: string): string {
  try {
    const rendered = marked.parse(content);
    // marked.parse can return string or Promise<string>, we only use sync
    if (typeof rendered === 'string') {
      return rendered.trim();
    }
    return content;
  } catch {
    return content;
  }
}

function Markdown({ children }: { children: string }) {
  const rendered = useMemo(() => renderMarkdown(children), [children]);
  return <Text>{rendered}</Text>;
}

export interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  result?: string;
  /** Tool arguments, used to render charts and embedded artifacts inline */
  args?: Record<string, unknown>;
}

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string; // Keep for backward compat / simple messages
  isStreaming?: boolean;
  parts?: MessagePart[]; // Interleaved content
  /** The model's reasoning for the turn in progress, when display.show_reasoning is on. */
  reasoning?: string;
  wasInterrupted?: boolean;
}

interface MessageListProps {
  messages: Message[];
  maxHeight?: number;
}

function formatTableAsMarkdown(headers: string[], rows: string[][]): string {
  const headerRow = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const dataRows = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${headerRow}\n${separator}\n${dataRows}`;
}

function EmbedArtifactDisplay({ toolCall }: { toolCall: ToolCall }) {
  const artifactId = toolCall.args?.artifactId as string | undefined;
  if (!artifactId) {
    return (
      <Box paddingLeft={4} marginY={0}>
        <Text color="red">embed_artifact: missing artifactId</Text>
      </Box>
    );
  }

  if (toolCall.status === 'running') {
    return (
      <Box paddingLeft={4} marginY={0}>
        <Text color="yellow">◐ Embedding artifact...</Text>
      </Box>
    );
  }

  const artifact = getArtifact(artifactId);
  if (!artifact) {
    return (
      <Box paddingLeft={4} marginY={0}>
        <Text color="red">● Artifact {artifactId} not found</Text>
      </Box>
    );
  }

  // Table and text artifacts share the same title + content layout
  let markdownContent: string;
  if (artifact.type === 'table') {
    const { headers, rows } = artifact.data as { headers: string[]; rows: string[][] };
    markdownContent = formatTableAsMarkdown(headers, rows);
  } else {
    markdownContent = (artifact.data as { content: string }).content;
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {artifact.title && (
        <Text bold color="cyan">
          {artifact.title}
        </Text>
      )}
      <Markdown>{markdownContent}</Markdown>
    </Box>
  );
}

function ToolCallDisplay({ toolCall }: { toolCall: ToolCall }) {
  const statusIcons = {
    pending: '○',
    running: '◐',
    completed: '●',
    error: '✗',
  } as const;

  const statusColors = {
    pending: 'gray',
    running: 'yellow',
    completed: 'green',
    error: 'red',
  } as const;

  // Render chart tool calls with special handling
  if (isChartToolCall(toolCall.name)) {
    if (toolCall.status === 'completed' && toolCall.args) {
      return (
        <Box flexDirection="column" paddingLeft={2}>
          <ChartRenderer toolArgs={toolCall.args} />
        </Box>
      );
    }
    if (toolCall.status === 'running') {
      return (
        <Box paddingLeft={4} marginY={0}>
          <Text color="yellow">{statusIcons.running} Generating chart...</Text>
        </Box>
      );
    }
  }

  // Render embedded artifacts inline
  if (toolCall.name === 'embed_artifact') {
    return <EmbedArtifactDisplay toolCall={toolCall} />;
  }

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
  const roleColors = {
    user: 'green',
    assistant: 'cyan',
    system: 'yellow',
  } as const;

  const roleLabels = {
    user: 'You',
    assistant: 'Solenoid',
    system: 'System',
  } as const;

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
