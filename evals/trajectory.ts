/**
 * Trajectory
 *
 * Folds the AG-UI events of a trial into the plain record checks read. The
 * one place that knows the event format: when it changes, this changes and
 * no case does.
 */
import { type AGUIEvent, EventType, type Message } from '@ag-ui/core';
import {
  CUSTOM_EVENTS,
  applyEvent,
  customValue,
  parseToolArgs,
  resultMetadata,
} from '../src/index.js';
import type { ToolCallRecord, Trajectory } from './case.js';

type Observed = Pick<Trajectory, 'toolCalls' | 'modelCalls' | 'retries' | 'tokens'> & {
  /** The conversation as a client holds it. */
  thread: Message[];
};

/** Collects a trial's events; `observed` is what they add up to so far. */
export function collector(): { onEvent: (event: AGUIEvent) => void; observed: () => Observed } {
  const calls = new Map<string, ToolCallRecord>();
  const sent = new Map<string, string>();
  const tokens = { input: 0, output: 0, reasoning: 0 };
  let thread: Message[] = [];
  let modelCalls = 0;
  let retries = 0;

  const onEvent = (event: AGUIEvent) => {
    thread = applyEvent(thread, event);
    if (customValue(event, CUSTOM_EVENTS.retry)) retries++;
    switch (event.type) {
      case EventType.STEP_STARTED:
        modelCalls++;
        break;
      case EventType.TOOL_CALL_START:
        // Unanswered until its result arrives: a run that dies mid-call leaves it failed.
        calls.set(event.toolCallId, {
          name: event.toolCallName,
          args: {},
          step: modelCalls,
          ok: false,
          output: '',
        });
        break;
      case EventType.TOOL_CALL_ARGS: {
        const json = (sent.get(event.toolCallId) ?? '') + event.delta;
        sent.set(event.toolCallId, json);
        const call = calls.get(event.toolCallId);
        if (call) call.args = parseToolArgs(json);
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        const call = calls.get(event.toolCallId);
        if (!call) break;
        const { error, declined, quarantined, malformed } = resultMetadata(event.metadata);
        Object.assign(call, {
          ok: !error && !declined && !quarantined,
          output: event.content,
          error,
          declined,
          quarantined,
          malformed,
        });
        break;
      }
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        for (const usage of event.usage ?? []) {
          tokens.input += usage.inputTokens ?? 0;
          tokens.output += usage.outputTokens ?? 0;
          tokens.reasoning += usage.reasoningTokens ?? 0;
        }
        break;
    }
  };

  return {
    onEvent,
    observed: () => ({ toolCalls: [...calls.values()], modelCalls, retries, tokens, thread }),
  };
}
