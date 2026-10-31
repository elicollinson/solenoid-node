/**
 * Main App Component
 *
 * Root React component for the terminal UI. Uses React Suspense while the
 * harness starts (MCP servers connect), then runs one conversation session
 * as an AG-UI client: every event is folded into the thread with the shared
 * reducer (../harness/ag-ui/reducer.ts), the message list is a view of that
 * thread, an interrupt opens the approval prompt and its answer resumes the
 * run, and the interrupt key aborts it.
 *
 * Dependencies:
 * - ink: React-based terminal UI framework
 * - React Suspense: Handles loading state during harness initialization
 */
import { type AGUIEvent, type Message as AgUiMessage, EventType } from '@ag-ui/core';
import { Box, Text, useApp, useInput } from 'ink';
import { Suspense, useMemo, useRef, useState } from 'react';
import { AgentAbortedError } from '../core/index.js';
import { APPROVAL_REASON, CUSTOM_EVENTS, applyEvent, describeRunError } from '../harness/index.js';
import { uiLogger } from '../utils/logger.js';
import { ApprovalPrompt, type PendingApproval } from './components/ApprovalPrompt.js';
import {
  ChatInput,
  ErrorBoundary,
  Header,
  HelpScreen,
  LoadingScreen,
  MessageList,
  SettingsScreen,
  StatusBar,
} from './components/index.js';
import { useAgent } from './hooks/index.js';
import { type Notice, type ViewCache, toView } from './thread.js';

type Screen = 'chat' | 'settings' | 'help';

interface ApprovalState extends PendingApproval {
  interruptId: string;
}

/** The tool call an approval interrupt is about, from the thread. */
function approvalFor(
  thread: readonly AgUiMessage[],
  interruptId: string,
  toolCallId?: string,
  message?: string
): ApprovalState {
  for (const m of thread) {
    if (m.role !== 'assistant') continue;
    const call = m.toolCalls?.find((c) => c.id === toolCallId);
    if (!call) continue;
    let args: unknown = call.function.arguments;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {}
    return { interruptId, tool: call.function.name, description: message ?? '', args };
  }
  return { interruptId, tool: 'a tool', description: message ?? '', args: {} };
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

  const [thread, setThread] = useState<AgUiMessage[]>([]);
  const [notices, setNotices] = useState<Notice[]>(() =>
    harness.warnings.map((text) => ({ id: crypto.randomUUID(), text, at: 0 }))
  );
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [screen, setScreen] = useState<Screen>('chat');
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<AgUiMessage[]>([]);
  const viewCache = useRef<ViewCache>(new Map());
  const interruptKey = harness.settings.keyboard.interrupt;
  const showReasoning = harness.settings.display.show_reasoning;

  const messages = useMemo(
    () => toView(thread, notices, { streaming: isProcessing, showReasoning }, viewCache.current),
    [thread, notices, isProcessing, showReasoning]
  );

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

  const addSystemMessage = (text: string) => {
    setNotices((prev) => [
      ...prev,
      { id: crypto.randomUUID(), text, at: threadRef.current.length },
    ]);
  };

  const fold = (event: AGUIEvent) => {
    threadRef.current = applyEvent(threadRef.current, event);
    setThread(threadRef.current);
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
        threadRef.current = [];
        setThread([]);
        setNotices([]);
        viewCache.current.clear();
        session.clear();
        return;
      case '/quit':
      case '/exit':
        exit();
        return;
      case '/tools': {
        const routes = harness.routes
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

  const onEvent = (event: AGUIEvent): void => {
    fold(event);
    switch (event.type) {
      case EventType.STEP_STARTED:
        setStatus('Thinking...');
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
        setStatus('Writing...');
        break;
      case EventType.TOOL_CALL_START:
        setStatus(`Running: ${event.toolCallName}`);
        break;
      case EventType.CUSTOM:
        if (event.name === CUSTOM_EVENTS.retry) {
          setStatus(`Retrying (${event.value.error})...`);
        } else if (event.name === CUSTOM_EVENTS.routeAdvanced) {
          setStatus(
            `${event.value.from.provider} failed; switching to ${event.value.to.provider}...`
          );
        } else if (event.name === CUSTOM_EVENTS.guardrail && event.value.decision === 'observe') {
          setStatus('Screen flagged your message; continuing');
        }
        break;
      case EventType.RUN_FINISHED: {
        const interrupt =
          event.outcome?.type === 'interrupt'
            ? event.outcome.interrupts.find((i) => i.reason === APPROVAL_REASON)
            : undefined;
        if (interrupt) {
          const pending = approvalFor(
            threadRef.current,
            interrupt.id,
            interrupt.toolCallId,
            interrupt.message
          );
          setApproval(pending);
          setStatus(`Waiting for approval: ${pending.tool}`);
        }
        break;
      }
    }
  };

  const answerApproval = (allow: boolean) => {
    if (!approval) return;
    setApproval(null);
    setStatus(allow ? `Running: ${approval.tool}` : 'Declined');
    session.resume([
      { interruptId: approval.interruptId, status: 'resolved', payload: { approved: allow } },
    ]);
  };

  const handleSubmit = async (text: string) => {
    uiLogger.info({ text }, 'handleSubmit called');

    if (text.startsWith('/')) {
      handleSlashCommand(text);
      return;
    }

    const messageId = crypto.randomUUID();
    fold({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...threadRef.current, { id: messageId, role: 'user', content: text }],
    });
    setIsProcessing(true);
    setStatus('Thinking...');

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await session.send(text, { signal: controller.signal, onEvent, messageId });
    } catch (error) {
      if (error instanceof AgentAbortedError) {
        addSystemMessage('Interrupted.');
      } else {
        uiLogger.error({ error: String(error) }, 'Run failed');
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

  const primary = harness.routes[0];

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <MessageList messages={messages} />
      </Box>
      {approval ? (
        <ApprovalPrompt approval={approval} onAnswer={answerApproval} />
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
