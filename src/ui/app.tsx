/**
 * Main App Component
 *
 * The terminal UI: an AG-UI client of one session. It folds every event
 * into its thread and draws a view of it; an approval interrupt opens the
 * prompt, whose answer resumes the run. Turns the session starts itself (a
 * subagent finished) run here just like the person's.
 */
import { type AGUIEvent, type Message as AgUiMessage, EventType } from '@ag-ui/core';
import { Box, Text, useApp, useInput } from 'ink';
import { Suspense, useEffect, useEffectEvent, useRef, useState } from 'react';
import { AgentAbortedError } from '../core/index.js';
import {
  APPROVAL_REASON,
  type AutoTurn,
  CUSTOM_EVENTS,
  applyEvent,
  approvalAnswer,
  customValue,
  describeRouteAdvance,
  describeRunError,
  findToolCall,
  parseToolArgs,
} from '../harness/index.js';
import { uiLogger } from '../utils/logger.js';
import {
  type ApprovalAnswer,
  ApprovalPrompt,
  type PendingApproval,
} from './components/ApprovalPrompt.js';
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

/** The approval interrupt the run is paused on: what it names, not a copy of the call. */
interface OpenApproval {
  interruptId: string;
  toolCallId?: string;
  message: string;
}

/** The conversation as this client has folded it, and notices posted into it. */
interface Chat {
  thread: AgUiMessage[];
  notices: Notice[];
}

function pendingApproval(thread: readonly AgUiMessage[], open: OpenApproval): PendingApproval {
  const call = open.toolCallId ? findToolCall(thread, open.toolCallId) : undefined;
  return {
    tool: call?.function.name ?? 'a tool',
    description: open.message,
    args: call ? parseToolArgs(call.function.arguments) : {},
  };
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

  const [chat, setChat] = useState<Chat>(() => ({
    thread: [],
    notices: harness.warnings.map((text) => ({ id: crypto.randomUUID(), text, at: 0 })),
  }));
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [screen, setScreen] = useState<Screen>('chat');
  const [openApproval, setOpenApproval] = useState<OpenApproval | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const interruptKey = harness.settings.keyboard.interrupt;
  const showReasoning = harness.settings.display.show_reasoning;
  const approval = openApproval && pendingApproval(chat.thread, openApproval);

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
    setChat((c) => ({
      ...c,
      notices: [...c.notices, { id: crypto.randomUUID(), text, at: c.thread.length }],
    }));
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
        setChat({ thread: [], notices: [] });
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
          }\n\nTools:\n${session.toolNames.map((n) => `  - ${n}`).join('\n')}`
        );
        return;
      }
      default:
        addSystemMessage(`Unknown command: ${command}. Type /help for available commands.`);
    }
  };

  const onEvent = (event: AGUIEvent): void => {
    const hidden =
      !showReasoning &&
      (event.type === EventType.REASONING_MESSAGE_START ||
        event.type === EventType.REASONING_MESSAGE_CONTENT);
    // Hidden reasoning changes nothing on screen, so it is not folded in.
    if (!hidden) setChat((c) => ({ ...c, thread: applyEvent(c.thread, event) }));
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
        if (route) setStatus(`${describeRouteAdvance(route)}...`);
        if (flag?.decision === 'observe') setStatus('Screen flagged your message; continuing');
        break;
      }
      case EventType.RUN_FINISHED: {
        const interrupt =
          event.outcome?.type === 'interrupt'
            ? event.outcome.interrupts.find((i) => i.reason === APPROVAL_REASON)
            : undefined;
        if (interrupt) {
          setOpenApproval({
            interruptId: interrupt.id,
            ...(interrupt.toolCallId ? { toolCallId: interrupt.toolCallId } : {}),
            message: interrupt.message ?? '',
          });
        }
        break;
      }
    }
  };

  const answerApproval = (answer: ApprovalAnswer) => {
    if (!openApproval || !approval) return;
    setOpenApproval(null);
    const allow = answer !== 'decline';
    setStatus(allow ? `Running: ${approval.tool}` : 'Declined');
    session.resume([approvalAnswer(openApproval.interruptId, allow ? 'allow' : 'decline')]);
    if (answer === 'always') {
      const failure = harness.allowAlways(approval.tool);
      if (failure) {
        uiLogger.warn({ failure, tool: approval.tool }, 'Could not save the approval rule');
        addSystemMessage(`Allowing ${approval.tool} until you quit; it could not be saved.`);
      }
    }
  };

  const runTurn = (turn: AutoTurn) => {
    setIsProcessing(true);
    setStatus('Thinking...');
    const controller = new AbortController();
    abortRef.current = controller;
    // A promise chain rather than try/finally, which React Compiler cannot
    // compile yet.
    turn({ signal: controller.signal, onEvent })
      .catch((error) => {
        if (!(error instanceof AgentAbortedError)) {
          uiLogger.error({ error: String(error) }, 'Run failed');
        }
        addSystemMessage(describeRunError(error));
      })
      .then(() => {
        // A news turn the session started as this one ended owns the state now.
        if (abortRef.current !== controller) return;
        abortRef.current = null;
        setOpenApproval(null);
        setIsProcessing(false);
        setStatus('Ready');
      });
  };

  const runAutoTurn = useEffectEvent(runTurn);
  // biome-ignore lint/correctness/useExhaustiveDependencies: an effect event is never a dependency.
  useEffect(() => session.onAutoTurn((turn) => runAutoTurn(turn)), [session]);

  const handleSubmit = (text: string) => {
    uiLogger.info({ text }, 'handleSubmit called');

    if (text.startsWith('/')) {
      handleSlashCommand(text);
      return;
    }
    runTurn((options) => session.send(text, options));
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
          thread={chat.thread}
          notices={chat.notices}
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
        status={approval ? `Waiting for approval: ${approval.tool}` : status}
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
