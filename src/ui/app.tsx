/**
 * Main App Component
 *
 * Root React component for the terminal UI. Uses React Suspense while the
 * harness starts (MCP servers connect), then runs one conversation session:
 * streams the agent's events into the message list, pauses for approval
 * before write tools, and aborts the run on the interrupt key.
 *
 * Dependencies:
 * - ink: React-based terminal UI framework
 * - React Suspense: Handles loading state during harness initialization
 */
import type { ToolVerdict } from '@elicollinson/solenoid-security';
import { Box, Text, useApp, useInput } from 'ink';
import { Suspense, useMemo, useRef, useState } from 'react';
import { clearArtifacts } from '../artifacts/index.js';
import { getInterruptKey } from '../config/index.js';
import { AgentAbortedError, type AgentEvent, type ApprovalRequest } from '../core/index.js';
import { declinedMessage, describeRunError } from '../harness/index.js';
import { uiLogger } from '../utils/logger.js';
import { ApprovalPrompt, type PendingApproval } from './components/ApprovalPrompt.js';
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

interface ApprovalState extends PendingApproval {
  resolve: (allow: boolean) => void;
}

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
      <Suspense fallback={<LoadingScreen message="Starting agent..." />}>
        <AppContent />
      </Suspense>
    </ErrorBoundary>
  );
}

function AppContent() {
  const { exit } = useApp();
  const { harness, session } = useAgent(); // Suspends until the harness is ready

  const [messages, setMessages] = useState<Message[]>(() =>
    harness.warnings.map((content) => ({ id: crypto.randomUUID(), role: 'system', content }))
  );
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [screen, setScreen] = useState<Screen>('chat');
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const interruptKey = useMemo(() => getInterruptKey(), []);
  const showReasoning = harness.settings.display.show_reasoning;

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

  // Interrupt handler - active during processing on chat screen. While an
  // approval is open its own keys answer it, so Esc declines rather than
  // aborting the whole run.
  useInput(
    (input, key) => {
      if (matchesInterruptKey(interruptKey, input, key)) {
        abortRef.current?.abort();
      }
    },
    { isActive: isProcessing && screen === 'chat' && !approval }
  );

  const addSystemMessage = (content: string) => {
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'system', content }]);
  };

  const handleSlashCommand = (command: string): void => {
    const cmd = command.toLowerCase().trim();
    switch (cmd) {
      case '/help':
        setScreen('help');
        return;
      case '/settings':
        setScreen('settings');
        return;
      case '/clear':
        setMessages([]);
        session.clear();
        clearArtifacts();
        return;
      case '/quit':
      case '/exit':
        exit();
        return;
      case '/tools': {
        const routes = harness.settings.routes
          .map((r, i) => `  ${i + 1}. ${r.provider}: ${r.model}`)
          .join('\n');
        const screening = harness.settings.screening;
        addSystemMessage(
          `Routes (tried in order):\n${routes}\n\nScreening: ${
            screening.enabled ? `${screening.provider}: ${screening.model}` : 'off'
          }\n\nTools:\n${harness.toolNames.map((n) => `  - ${n}`).join('\n')}`
        );
        return;
      }
      default:
        addSystemMessage(`Unknown command: ${command}. Type /help for available commands.`);
    }
  };

  const handleSubmit = async (text: string) => {
    uiLogger.info({ text }, 'handleSubmit called');

    if (text.startsWith('/')) {
      handleSlashCommand(text);
      return;
    }

    // Clear artifact store from previous turn
    clearArtifacts();

    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: text };
    const assistantMessageId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      userMessage,
      { id: assistantMessageId, role: 'assistant', content: '', isStreaming: true, parts: [] },
    ]);
    setIsProcessing(true);
    setStatus('Thinking...');

    // Parts of the reply as drawn. `turnStart` marks where the model call in
    // progress began, so a retried call can drop its partial output.
    let parts: MessagePart[] = [];
    let turnStart = 0;
    let reasoning = '';
    const toolCalls = new Map<string, ToolCall>();

    const textOf = (list: MessagePart[]) =>
      list
        .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.content)
        .join('');

    const updateAssistant = (updates: Partial<Message> = {}): void => {
      const snapshot = [...parts];
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId
            ? {
                ...msg,
                content: textOf(snapshot),
                parts: snapshot,
                reasoning: showReasoning ? reasoning : undefined,
                ...updates,
              }
            : msg
        )
      );
    };

    const onEvent = (event: AgentEvent): void => {
      switch (event.type) {
        case 'turn_start':
          turnStart = parts.length;
          reasoning = '';
          setStatus('Thinking...');
          break;

        case 'reasoning_delta':
          reasoning += event.text;
          if (showReasoning) updateAssistant();
          break;

        case 'text_delta': {
          const last = parts[parts.length - 1];
          if (last && last.type === 'text' && parts.length > turnStart) {
            parts[parts.length - 1] = { type: 'text', content: last.content + event.text };
          } else {
            parts.push({ type: 'text', content: event.text });
          }
          setStatus('Writing...');
          updateAssistant();
          break;
        }

        case 'tool_start': {
          const args =
            event.args && typeof event.args === 'object'
              ? (event.args as Record<string, unknown>)
              : { raw: event.args };
          const toolCall: ToolCall = { id: event.id, name: event.name, status: 'running', args };
          toolCalls.set(event.id, toolCall);
          parts.push({ type: 'tool_call', toolCall });
          setStatus(`Running: ${event.name}`);
          updateAssistant();
          break;
        }

        case 'tool_end': {
          const toolCall = toolCalls.get(event.id);
          if (toolCall) {
            toolCall.status = event.ok && !event.declined ? 'completed' : 'error';
            if (!event.ok || event.declined) {
              toolCall.result = event.quarantined
                ? 'output blocked: possible prompt injection'
                : event.declined
                  ? 'declined'
                  : event.output.replace(/^Error:\s*/, '');
            }
            parts = parts.map((p) =>
              p.type === 'tool_call' && p.toolCall.id === event.id
                ? { ...p, toolCall: { ...toolCall } }
                : p
            );
            updateAssistant();
          }
          break;
        }

        case 'retry':
          parts = parts.slice(0, turnStart);
          setStatus(`Retrying (${event.error})...`);
          updateAssistant();
          break;

        case 'route_advanced':
          // The task restarts from scratch on the next route.
          parts = [];
          turnStart = 0;
          toolCalls.clear();
          clearArtifacts();
          setStatus(`${event.from.provider} failed; switching to ${event.to.provider}...`);
          updateAssistant();
          break;

        case 'guardrail':
          if (event.decision === 'observe') {
            setStatus('Screen flagged your message; continuing');
          }
          break;
      }
    };

    const approve = (request: ApprovalRequest): Promise<ToolVerdict> =>
      new Promise((resolve) => {
        const finish = (allow: boolean) => {
          request.signal.removeEventListener('abort', onAbort);
          setApproval(null);
          setStatus(allow ? `Running: ${request.tool}` : 'Declined');
          resolve(
            allow
              ? { allow: true }
              : { allow: false, tell: declinedMessage(request.tool, 'declined') }
          );
        };
        const onAbort = () => finish(false);
        request.signal.addEventListener('abort', onAbort, { once: true });
        setStatus(`Waiting for approval: ${request.tool}`);
        setApproval({
          tool: request.tool,
          description: request.description,
          args: request.args,
          resolve: finish,
        });
      });

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await session.send(text, { signal: controller.signal, onEvent, approve });
      for (const tc of toolCalls.values()) if (tc.status === 'running') tc.status = 'completed';
      updateAssistant({ isStreaming: false });
    } catch (error) {
      if (error instanceof AgentAbortedError) {
        updateAssistant({ isStreaming: false, wasInterrupted: true });
      } else {
        uiLogger.error({ error: String(error) }, 'Run failed');
        updateAssistant({ isStreaming: false });
        addSystemMessage(describeRunError(error));
      }
    } finally {
      abortRef.current = null;
      setApproval(null);
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

  const primary = harness.settings.routes[0];

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <MessageList messages={messages} />
      </Box>
      {approval ? (
        <ApprovalPrompt approval={approval} onAnswer={(allow) => approval.resolve(allow)} />
      ) : (
        <ChatInput
          onSubmit={handleSubmit}
          isDisabled={isProcessing}
          placeholder={
            isProcessing ? 'Waiting for response...' : 'Ask the agent... (type /help for commands)'
          }
        />
      )}
      <StatusBar
        isLoading={isProcessing}
        status={status}
        interruptHint={formatInterruptHint(interruptKey)}
      />
      {primary && (
        <Box paddingX={1}>
          <Text dimColor>
            {primary.provider}: {primary.model}
            {harness.settings.screening.enabled ? ' · screening on' : ' · screening off'}
          </Text>
        </Box>
      )}
    </Box>
  );
}
