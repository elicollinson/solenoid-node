/**
 * Runner Retry Logic Tests
 *
 * Validates that the agent runner handles empty model responses correctly:
 * - Retries with exponential backoff on empty final events
 * - Yields status events during backoff so the UI can show retry state
 * - Surfaces errorCode/errorMessage from ADK in status and final error
 * - Yields a user-facing error when retries are exhausted
 * - Passes through normal responses without retry
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { runAgent } from '../../src/agents/runner.js';

// ---------------------------------------------------------------------------
// Mock setTimeout to eliminate backoff delays in tests
// ---------------------------------------------------------------------------

const originalSetTimeout = globalThis.setTimeout;

function installFastTimers() {
  (globalThis as any).setTimeout = (fn: () => void, _ms?: number) => {
    return originalSetTimeout(fn, 0);
  };
}

function restoreTimers() {
  globalThis.setTimeout = originalSetTimeout;
}

// ---------------------------------------------------------------------------
// Helpers to build mock ADK events
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: {
    author?: string;
    parts?: Array<Record<string, unknown>>;
    role?: string;
    errorCode?: string;
    errorMessage?: string;
    actions?: Record<string, unknown>;
    partial?: boolean;
  } = {}
) {
  return {
    id: crypto.randomUUID(),
    invocationId: '',
    author: overrides.author ?? 'test_agent',
    content: {
      role: overrides.role ?? 'model',
      parts: overrides.parts ?? [],
    },
    actions: {
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
      ...(overrides.actions ?? {}),
    },
    longRunningToolIds: [],
    timestamp: Date.now(),
    partial: overrides.partial ?? false,
    ...(overrides.errorCode != null ? { errorCode: overrides.errorCode } : {}),
    ...(overrides.errorMessage != null ? { errorMessage: overrides.errorMessage } : {}),
  };
}

/** A final event with text content — the happy path */
function makeFinalTextEvent(text: string) {
  return makeEvent({ parts: [{ text }] });
}

/** A final event with no content — triggers retry */
function makeEmptyFinalEvent(extra?: { errorCode?: string; errorMessage?: string }) {
  return makeEvent({ parts: [], ...extra });
}

// ---------------------------------------------------------------------------
// Mock InMemoryRunner
// ---------------------------------------------------------------------------

interface RunAsyncParams {
  userId: string;
  sessionId: string;
  newMessage: { role: string; parts: Array<{ text: string }> };
}

function createMockRunner(
  /** Called each time runAsync is invoked; return events to yield. */
  onRunAsync: (params: RunAsyncParams, callIndex: number) => Array<ReturnType<typeof makeEvent>>
) {
  let callIndex = 0;

  return {
    sessionService: {
      getSession: mock(async () => ({ id: 'test-session' })),
      createSession: mock(async () => ({ id: 'test-session' })),
    },
    runAsync(params: RunAsyncParams) {
      const events = onRunAsync(params, callIndex++);
      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    },
  } as any; // cast to InMemoryRunner
}

// ---------------------------------------------------------------------------
// Collect all chunks from the async generator
// ---------------------------------------------------------------------------

async function collectChunks(gen: ReturnType<typeof runAgent>) {
  const chunks: Array<{ type: string; content?: string; [key: string]: unknown }> = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Runner retry on empty model response', () => {
  beforeEach(() => installFastTimers());
  afterEach(() => restoreTimers());

  it('yields text and done on a normal response (no retry)', async () => {
    const runner = createMockRunner(() => [makeFinalTextEvent('Hello world')]);

    const chunks = await collectChunks(runAgent('hi', runner, 'sess-1'));

    expect(chunks).toEqual([
      { type: 'text', content: 'Hello world' },
      { type: 'done' },
    ]);
  });

  it('retries on empty final event and succeeds', async () => {
    const messages: string[] = [];
    const runner = createMockRunner((params, callIndex) => {
      messages.push(params.newMessage.parts[0].text);
      if (callIndex === 0) {
        return [makeEmptyFinalEvent()];
      }
      return [makeFinalTextEvent('Recovered response')];
    });

    const chunks = await collectChunks(runAgent('research topic', runner, 'sess-2'));

    // Should have retried with a "continue" message
    expect(messages).toEqual(['research topic', 'Please continue with your response.']);

    // Should yield status event before retry, then the recovered content
    const statusChunks = chunks.filter((c) => c.type === 'status');
    expect(statusChunks.length).toBe(1);
    expect(statusChunks[0].content).toContain('Retrying');

    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toEqual([{ type: 'text', content: 'Recovered response' }]);
    expect(chunks[chunks.length - 1].type).toBe('done');
  });

  it('yields user-facing error with reason when all retries exhausted', async () => {
    const runner = createMockRunner(() => [makeEmptyFinalEvent()]);

    const chunks = await collectChunks(runAgent('query', runner, 'sess-3'));

    // Should have status events for each retry
    const statusChunks = chunks.filter((c) => c.type === 'status');
    expect(statusChunks.length).toBe(5); // 5 retries = 5 status events

    // Final chunk should be user-facing error with the reason
    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toHaveLength(1);
    expect(textChunks[0].content).toContain('failed after 6 attempts');
    expect(textChunks[0].content).toContain('empty response');
    expect(chunks[chunks.length - 1].type).toBe('done');
  });

  it('surfaces API error message in status events and final error', async () => {
    const runner = createMockRunner((_params, callIndex) => {
      if (callIndex === 0) {
        return [
          makeEmptyFinalEvent({
            errorCode: '503',
            errorMessage: 'This model is currently experiencing high demand.',
          }),
        ];
      }
      return [makeFinalTextEvent('OK after rate limit')];
    });

    const chunks = await collectChunks(runAgent('trigger rate limit', runner, 'sess-4'));

    // Status event should show the actual API error
    const statusChunks = chunks.filter((c) => c.type === 'status');
    expect(statusChunks.length).toBe(1);
    expect(statusChunks[0].content).toContain('high demand');

    // Should recover on retry
    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toEqual([{ type: 'text', content: 'OK after rate limit' }]);
  });

  it('includes API error in final message when retries exhausted', async () => {
    const runner = createMockRunner(() => [
      makeEmptyFinalEvent({
        errorCode: '503',
        errorMessage: 'Service temporarily unavailable',
      }),
    ]);

    const chunks = await collectChunks(runAgent('always fails', runner, 'sess-4b'));

    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toHaveLength(1);
    expect(textChunks[0].content).toContain('Service temporarily unavailable');
  });

  it('does not retry when final event has content', async () => {
    let runAsyncCallCount = 0;
    const runner = createMockRunner(() => {
      runAsyncCallCount++;
      return [makeFinalTextEvent('First response')];
    });

    const chunks = await collectChunks(runAgent('hello', runner, 'sess-5'));

    expect(runAsyncCallCount).toBe(1); // No retry
    expect(chunks).toEqual([
      { type: 'text', content: 'First response' },
      { type: 'done' },
    ]);
  });

  it('does not retry when final event has a transfer action', async () => {
    let runAsyncCallCount = 0;
    const runner = createMockRunner(() => {
      runAsyncCallCount++;
      return [
        makeEvent({
          parts: [],
          actions: {
            stateDelta: {},
            artifactDelta: {},
            requestedAuthConfigs: {},
            requestedToolConfirmations: {},
            transferToAgent: 'research_agent',
          },
        }),
      ];
    });

    const chunks = await collectChunks(runAgent('delegate', runner, 'sess-6'));

    expect(runAsyncCallCount).toBe(1); // No retry — transfer counts as content
    expect(chunks).toEqual([{ type: 'done' }]);
  });

  it('yields tool_call chunks before retrying on empty final', async () => {
    const runner = createMockRunner((_params, callIndex) => {
      if (callIndex === 0) {
        return [
          // First: a tool call event (not final — has functionCall)
          makeEvent({
            parts: [{ functionCall: { name: 'universal_search', args: { query: 'test' } } }],
          }),
          // Then: empty final (model returned nothing after tool results)
          makeEmptyFinalEvent(),
        ];
      }
      return [makeFinalTextEvent('Here are the results')];
    });

    const chunks = await collectChunks(runAgent('search something', runner, 'sess-7'));

    // Tool call should have been yielded before the retry
    expect(chunks[0]).toEqual({
      type: 'tool_call',
      toolCall: {
        function: {
          name: 'universal_search',
          arguments: { query: 'test' },
        },
      },
    });
    // Status event before retry
    expect(chunks[1].type).toBe('status');
    // Then the retry succeeds
    expect(chunks[2]).toEqual({ type: 'text', content: 'Here are the results' });
    expect(chunks[3]).toEqual({ type: 'done' });
  });

  it('handles exceptions during runAsync gracefully', async () => {
    const runner = createMockRunner(() => {
      throw new Error('Network timeout');
    });

    const chunks = await collectChunks(runAgent('crash', runner, 'sess-8'));

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('text');
    expect(chunks[0].content).toContain('Network timeout');
    expect(chunks[1].type).toBe('done');
  });

  it('retries multiple times before succeeding', async () => {
    let callCount = 0;
    const runner = createMockRunner((_params) => {
      callCount++;
      if (callCount < 4) {
        return [makeEmptyFinalEvent()];
      }
      return [makeFinalTextEvent('Finally worked')];
    });

    const chunks = await collectChunks(runAgent('slow recovery', runner, 'sess-9'));

    // Should have 4 runAsync calls (initial + 3 retries)
    expect(callCount).toBe(4);

    // Should have 3 status events (one per retry)
    const statusChunks = chunks.filter((c) => c.type === 'status');
    expect(statusChunks).toHaveLength(3);

    // Should have recovered
    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toEqual([{ type: 'text', content: 'Finally worked' }]);
  });

  it('uses exponential backoff delays between retries', async () => {
    // Restore real timers for this specific test
    restoreTimers();

    const timestamps: number[] = [];
    const runner = createMockRunner((_params, callIndex) => {
      timestamps.push(Date.now());
      if (callIndex < 2) {
        return [makeEmptyFinalEvent()];
      }
      return [makeFinalTextEvent('Done')];
    });

    await collectChunks(runAgent('timing test', runner, 'sess-9b'));

    // Should have 3 calls (initial + 2 retries)
    expect(timestamps).toHaveLength(3);

    // First retry: ~1000ms, second retry: ~2000ms
    const delay1 = timestamps[1] - timestamps[0];
    const delay2 = timestamps[2] - timestamps[1];
    expect(delay1).toBeGreaterThanOrEqual(900);
    expect(delay2).toBeGreaterThanOrEqual(1800);
    expect(delay2).toBeGreaterThan(delay1);
  });

  it('yields correct retry count in status messages', async () => {
    let callCount = 0;
    const runner = createMockRunner(() => {
      callCount++;
      if (callCount <= 3) {
        return [makeEmptyFinalEvent()];
      }
      return [makeFinalTextEvent('Done')];
    });

    const chunks = await collectChunks(runAgent('counting', runner, 'sess-10'));

    const statusChunks = chunks.filter((c) => c.type === 'status');
    expect(statusChunks).toHaveLength(3);
    expect(statusChunks[0].content).toContain('1/5');
    expect(statusChunks[1].content).toContain('2/5');
    expect(statusChunks[2].content).toContain('3/5');
  });
});
