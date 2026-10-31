/**
 * Main App Component
 *
 * The terminal UI: an AG-UI client of one session. It folds every event
 * into its thread and draws a view of it; an approval interrupt opens the
 * prompt, whose answer resumes the run.
 */
import { type AGUIEvent, type Message as AgUiMessage, EventType } from '@ag-ui/core';
import { Box, Text, useApp, useInput } from 'ink';
import { Suspense, useRef, useState } from 'react';
import { AgentAbortedError } from '../core/index.js';
import {
  APPROVAL_REASON,
  CUSTOM_EVENTS,
  applyEvent,
  approvalAnswer,
  customValue,
  describeRunError,
  findToolCall,
  parseToolArgs,
} from '../harness/index.js';
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
import type { Notice } from './thread.js';

type Screen = 'chat' | 'settings' | 'help';

interface ApprovalState extends PendingApproval {
  interruptId: string;
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
  const interruptKey = harness.settings.keyboard.interrupt;
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

  // The session holds the same thread this client folds, so handlers read
  // it there rather than from state captured by an older render.
  const addSystemMessage = (text: string) => {
    const at = session.messages.length;
    setNotices((prev) => [...prev, { id: crypto.randomUUID(), text, at }]);
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
        session.clear();
        setThread([]);
        setNotices([]);
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
    setThread((current) => applyEvent(current, event));
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
      case EventType.CUSTOM: {
        const retry = customValue(event, CUSTOM_EVENTS.retry);
        const route = customValue(event, CUSTOM_EVENTS.routeAdvanced);
        const flag = customValue(event, CUSTOM_EVENTS.guardrail);
        if (retry) setStatus(`Retrying (${retry.error})...`);
        if (route) setStatus(`${route.from.provider} failed; switching to ${route.to.provider}...`);
        if (flag?.decision === 'observe') setStatus('Screen flagged your message; continuing');
        break;
      }
      case EventType.RUN_FINISHED: {
        const interrupt =
          event.outcome?.type === 'interrupt'
            ? event.outcome.interrupts.find((i) => i.reason === APPROVAL_REASON)
            : undefined;
        if (interrupt) {
          // The interrupt names the call; the thread holds what it asked for.
          const call = interrupt.toolCallId
            ? findToolCall(session.messages, interrupt.toolCallId)
            : undefined;
          const tool = call?.function.name ?? 'a tool';
          setApproval({
            interruptId: interrupt.id,
            tool,
            description: interrupt.message ?? '',
            args: call ? parseToolArgs(call.function.arguments) : {},
          });
          setStatus(`Waiting for approval: ${tool}`);
        }
        break;
      }
    }
  };

  const answerApproval = (allow: boolean) => {
    if (!approval) return;
    setApproval(null);
    setStatus(allow ? `Running: ${approval.tool}` : 'Declined');
    session.resume([approvalAnswer(approval.interruptId, allow ? 'allow' : 'decline')]);
  };

  const handleSubmit = (text: string) => {
    uiLogger.info({ text }, 'handleSubmit called');

    if (text.startsWith('/')) {
      handleSlashCommand(text);
      return;
    }

    setIsProcessing(true);
    setStatus('Thinking...');
    const controller = new AbortController();
    abortRef.current = controller;
    // A promise chain rather than try/finally, which React Compiler cannot
    // compile yet.
    session
      .send(text, { signal: controller.signal, onEvent })
      .catch((error) => {
        if (error instanceof AgentAbortedError) {
          addSystemMessage('Interrupted.');
        } else {
          uiLogger.error({ error: String(error) }, 'Run failed');
          addSystemMessage(describeRunError(error));
        }
      })
      .then(() => {
        abortRef.current = null;
        setApproval(null);
        setIsProcessing(false);
        setStatus('Ready');
      });
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
        <MessageList
          thread={thread}
          notices={notices}
          streaming={isProcessing}
          showReasoning={showReasoning}
        />
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
