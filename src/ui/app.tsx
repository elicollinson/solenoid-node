/**
 * Main App Component
 *
 * Root React component for the terminal UI. Uses React 18 Suspense for
 * agent initialization loading state. Manages chat state, screen navigation,
 * and direct ADK agent invocation.
 *
 * Dependencies:
 * - ink: React-based terminal UI framework
 * - React Suspense: Handles loading state during agent initialization
 */
import { Box, useApp, useInput } from 'ink';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { clearArtifacts } from '../artifacts/index.js';
import { getInterruptKey, tryLoadSettings } from '../config/index.js';
import { uiLogger } from '../utils/logger.js';
import {
  ChatInput,
  ErrorBoundary,
  Header,
  HelpScreen,
  LoadingScreen,
  type Message,
  MessageList,
  type MessagePart,
  SettingsScreen,
  StatusBar,
  type ToolCall,
} from './components/index.js';
import { useAgent } from './hooks/index.js';

type Screen = 'chat' | 'settings' | 'help';

function formatInterruptHint(interruptKey: string): string {
  const label = interruptKey === 'escape' ? 'Esc' : interruptKey;
  return `${label} to interrupt`;
}

function matchesInterruptKey(
  interruptKey: string,
  input: string,
  key: { escape?: boolean; tab?: boolean }
): boolean {
  if (interruptKey === 'escape') return !!key.escape;
  if (interruptKey === 'tab') return !!key.tab;
  return input === interruptKey;
}

export function App() {
  return (
    <ErrorBoundary fallback={(error) => <LoadingScreen error={error} />}>
      <Suspense fallback={<LoadingScreen message="Initializing agents..." />}>
        <AppContent />
      </Suspense>
    </ErrorBoundary>
  );
}

function AppContent() {
  const { exit } = useApp();
  const agent = useAgent(); // Will suspend until MCP tools are loaded

  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [screen, setScreen] = useState<Screen>('chat');
  const interruptRef = useRef(false);
  const interruptKey = useMemo(() => getInterruptKey(), []);

  useEffect(() => {
    const settings = tryLoadSettings();
    if (settings) {
      uiLogger.info('Settings loaded successfully');
    } else {
      uiLogger.warn('Settings not available');
    }
  }, []);

  // Keep stdin ref'd so the process doesn't exit while idle. Ink 6's
  // useInput cleanup unrefs stdin, and an always-active no-op handler
  // ensures at least one ref keeps the event loop alive between renders
  // (e.g., while waiting at the prompt with no other useInput active).
  useInput(() => {});

  // Escape key handler for non-chat screens
  useInput(
    (_char, key) => {
      if (key.escape) {
        uiLogger.info('Escape pressed, returning to chat');
        setScreen('chat');
      }
    },
    { isActive: screen !== 'chat' }
  );

  // Interrupt handler - active during processing on chat screen
  useInput(
    (input, key) => {
      if (matchesInterruptKey(interruptKey, input, key)) {
        interruptRef.current = true;
      }
    },
    { isActive: isProcessing && screen === 'chat' }
  );

  const handleSlashCommand = (command: string): boolean => {
    const cmd = command.toLowerCase().trim();
    switch (cmd) {
      case '/help':
        setScreen('help');
        return true;
      case '/settings':
        setScreen('settings');
        return true;
      case '/clear':
        setMessages([]);
        return true;
      case '/quit':
      case '/exit':
        exit();
        return true;
      case '/agents': {
        const agentList: Message = {
          id: crypto.randomUUID(),
          role: 'system',
          content: `Available agents:
  - research_agent: Web search and research tasks
  - code_executor_agent: Execute Python code
  - chart_generator_agent: Create Pygal charts
  - generic_agent: General text tasks
  - mcp_agent: External tool integrations`,
        };
        setMessages((prev) => [...prev, agentList]);
        return true;
      }
      default: {
        const unknownCmd: Message = {
          id: crypto.randomUUID(),
          role: 'system',
          content: `Unknown command: ${command}. Type /help for available commands.`,
        };
        setMessages((prev) => [...prev, unknownCmd]);
        return true;
      }
    }
  };

  const handleSubmit = async (text: string) => {
    uiLogger.info({ text }, 'handleSubmit called');

    // Handle slash commands
    if (text.startsWith('/')) {
      uiLogger.debug({ text }, 'Processing slash command');
      handleSlashCommand(text);
      return;
    }

    // Clear artifact store from previous turn
    clearArtifacts();

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    };
    uiLogger.debug({ messageId: userMessage.id }, 'Adding user message');
    setMessages((prev) => [...prev, userMessage]);
    setIsProcessing(true);
    setStatus('Thinking...');

    const assistantMessageId = crypto.randomUUID();
    const parts: MessagePart[] = [];
    const toolCallMap = new Map<string, ToolCall>();

    // Helper to update only the assistant message being streamed
    const updateAssistant = (updates: Partial<Message>): void => {
      setMessages((prev) =>
        prev.map((msg) => (msg.id === assistantMessageId ? { ...msg, ...updates } : msg))
      );
    };

    setMessages((prev) => [
      ...prev,
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        parts: [],
      },
    ]);

    try {
      interruptRef.current = false;
      // Direct ADK invocation via hook
      for await (const event of agent.run(text)) {
        if (interruptRef.current) break;
        switch (event.type) {
          case 'text':
            if (event.content) {
              // Append to last text part or create new one
              const lastPart = parts[parts.length - 1];
              if (lastPart && lastPart.type === 'text') {
                lastPart.content += event.content;
              } else {
                parts.push({ type: 'text', content: event.content });
              }
              updateAssistant({
                content: parts
                  .filter((p) => p.type === 'text')
                  .map((p) => p.content)
                  .join(''),
                parts: [...parts],
              });
            }
            break;

          case 'tool_start':
            if (event.toolCallId && event.toolName) {
              const newToolCall: ToolCall = {
                id: event.toolCallId,
                name: event.toolName,
                status: 'running',
              };
              toolCallMap.set(event.toolCallId, newToolCall);
              parts.push({ type: 'tool_call', toolCall: newToolCall });
              setStatus(`Running: ${event.toolName}`);
              updateAssistant({ parts: [...parts] });
            }
            break;

          case 'tool_args':
            if (event.toolCallId && event.toolArgs) {
              const tc = toolCallMap.get(event.toolCallId);
              if (tc) {
                try {
                  tc.args = JSON.parse(event.toolArgs);
                } catch {
                  tc.args = { raw: event.toolArgs };
                }
                updateAssistant({ parts: [...parts] });
              }
            }
            break;

          case 'tool_end':
            if (event.toolCallId) {
              const tc = toolCallMap.get(event.toolCallId);
              if (tc) {
                tc.status = 'completed';
                updateAssistant({ parts: [...parts] });
              }
            }
            break;

          case 'transfer':
            if (event.transferTo) {
              setStatus(`Agent: ${event.transferTo}`);

              // Clear intermediate progression when response_formatting_agent takes over
              if (event.transferTo === 'response_formatting_agent') {
                const clearProgression =
                  tryLoadSettings()?.display.clear_progression_on_final ?? true;
                if (clearProgression) {
                  parts.length = 0;
                  toolCallMap.clear();
                }
              }

              updateAssistant({ agentName: event.transferTo, parts: [...parts] });
            }
            break;

          case 'status':
            if (event.content) {
              setStatus(event.content);
            }
            break;

          case 'error':
            updateAssistant({
              content: `Error: ${event.error}`,
              isStreaming: false,
            });
            break;
        }
      }

      const wasInterrupted = interruptRef.current;

      // Mark any remaining running tool calls as completed
      for (const tc of toolCallMap.values()) {
        if (tc.status === 'running') {
          tc.status = 'completed';
        }
      }

      updateAssistant({ isStreaming: false, parts: [...parts], wasInterrupted });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      updateAssistant({ content: `Error: ${errorMessage}`, isStreaming: false });
    } finally {
      interruptRef.current = false;
      setIsProcessing(false);
      setStatus('Ready');
    }
  };

  if (screen === 'settings') {
    return <SettingsScreen onClose={() => setScreen('chat')} />;
  }
  if (screen === 'help') {
    return <HelpScreen onClose={() => setScreen('chat')} />;
  }

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <MessageList messages={messages} />
      </Box>
      <ChatInput
        onSubmit={handleSubmit}
        isDisabled={isProcessing}
        placeholder={
          isProcessing ? 'Waiting for response...' : 'Ask the agent... (type /help for commands)'
        }
      />
      <StatusBar
        isLoading={isProcessing}
        status={status}
        interruptHint={formatInterruptHint(interruptKey)}
      />
    </Box>
  );
}
