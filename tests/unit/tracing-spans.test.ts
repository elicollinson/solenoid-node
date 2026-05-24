/**
 * Tracing Span Hierarchy Tests
 *
 * Validates that OTel spans emitted during agent runs have the correct
 * parent-child hierarchy. ADK v0.3.0 creates its own spans (invocation,
 * invoke_agent, execute_tool) and these must nest under Solenoid's root
 * `solenoid.agent_run` span so they appear as a single trace in Weave.
 *
 * Uses an InMemorySpanExporter to capture spans without any external service.
 *
 * Note: OTel SDK v2.x uses `parentSpanContext?.spanId` instead of `parentSpanId`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { runAgent } from '../../src/agents/runner.js';

// ---------------------------------------------------------------------------
// Mock setTimeout to eliminate backoff delays
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
// OTel test infrastructure — set up ONCE for all tests to avoid
// re-registration issues with the global tracer provider.
// ---------------------------------------------------------------------------

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the parent span ID from a ReadableSpan.
 * OTel SDK v2.x moved from `parentSpanId: string` to `parentSpanContext: SpanContext`.
 */
function getParentSpanId(span: ReadableSpan): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: parentSpanContext not in ReadableSpan TS types for all SDK versions
  const psc = (span as any).parentSpanContext;
  if (psc?.spanId) return psc.spanId;
  // Fallback for SDK v1.x
  return (span as unknown as { parentSpanId?: string }).parentSpanId;
}

function makeEvent(
  overrides: {
    author?: string;
    parts?: Array<Record<string, unknown>>;
    role?: string;
    actions?: Record<string, unknown>;
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
    partial: false,
  };
}

function makeFinalTextEvent(text: string) {
  return makeEvent({ parts: [{ text }] });
}

interface RunAsyncParams {
  userId: string;
  sessionId: string;
  newMessage: { role: string; parts: Array<{ text: string }> };
}

/**
 * Create a mock runner that emits spans like ADK does internally.
 * Simulates the span creation in Runner.runAsync → BaseAgent.runAsync → callToolAsync.
 * Uses context.active() to pick up parent context, just like real ADK code.
 */
function createMockRunnerWithSpans(
  onRunAsync: (params: RunAsyncParams, callIndex: number) => Array<ReturnType<typeof makeEvent>>
) {
  let callIndex = 0;
  const adkTracer = trace.getTracer('gcp.vertex.agent');

  return {
    sessionService: {
      getSession: async () => ({ id: 'test-session' }),
      createSession: async () => ({ id: 'test-session' }),
    },
    runAsync(params: RunAsyncParams) {
      const idx = callIndex++;
      // Simulate ADK's async generator: span creation uses context.active()
      // just like real ADK Runner.runAsync and BaseAgent.runAsync do.
      return (async function* () {
        // ADK Runner.runAsync: creates "invocation" span from active context
        const invocationSpan = adkTracer.startSpan('invocation', {}, context.active());
        const invocationCtx = trace.setSpan(context.active(), invocationSpan);

        try {
          // ADK BaseAgent.runAsync: creates "invoke_agent" span under invocation
          const agentSpan = adkTracer.startSpan(
            'invoke_agent test_agent',
            {},
            invocationCtx
          );
          const agentCtx = trace.setSpan(invocationCtx, agentSpan);

          try {
            const events = onRunAsync(params, idx);
            for (const event of events) {
              // Simulate tool span if event has functionCall
              if (event.content?.parts?.some((p: any) => p.functionCall)) {
                const toolSpan = adkTracer.startSpan(
                  'execute_tool mock_tool',
                  {},
                  agentCtx
                );
                toolSpan.end();
              }
              yield event;
            }
          } finally {
            agentSpan.end();
          }
        } finally {
          invocationSpan.end();
        }
      })();
    },
  } as any;
}

async function collectChunks(gen: ReturnType<typeof runAgent>) {
  const chunks: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

function getSpansByName(spans: ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name);
}

function getSpanByName(spans: ReadableSpan[], name: string): ReadableSpan {
  const matches = getSpansByName(spans, name);
  if (matches.length !== 1) {
    const allNames = spans
      .map((s) => `${s.name}(parent=${getParentSpanId(s) ?? 'root'})`)
      .join(', ');
    throw new Error(
      `Expected 1 span named "${name}", found ${matches.length}. All spans: [${allNames}]`
    );
  }
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tracing span hierarchy', () => {
  beforeAll(() => {
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    // register() sets up: global tracer provider + AsyncLocalStorageContextManager + propagator
    provider.register();
  });

  beforeEach(() => {
    installFastTimers();
    exporter.reset();
  });

  afterAll(async () => {
    restoreTimers();
    await provider.forceFlush();
    await provider.shutdown();
  });

  it('explicit context propagates parent span to child (sanity check)', async () => {
    const t = trace.getTracer('test-sanity');
    const parentSpan = t.startSpan('parent');
    const parentCtx = trace.setSpan(context.active(), parentSpan);
    const childSpan = t.startSpan('child', {}, parentCtx);
    childSpan.end();
    parentSpan.end();

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const parent = spans.find((s) => s.name === 'parent')!;
    const child = spans.find((s) => s.name === 'child')!;

    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(getParentSpanId(child)).toBe(parent.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  });

  it('root span solenoid.agent_run is emitted with Weave attributes', async () => {
    const runner = createMockRunnerWithSpans(() => [makeFinalTextEvent('hello')]);
    await collectChunks(runAgent('test input', runner, 'session-123'));

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const rootSpan = getSpanByName(spans, 'solenoid.agent_run');
    expect(rootSpan).toBeDefined();

    const attrs = rootSpan.attributes;
    expect(attrs['solenoid.session_id']).toBe('session-123');
    expect(attrs['wandb.thread_id']).toBe('session-123');
    expect(attrs['wandb.is_turn']).toBe(true);
    expect(attrs['solenoid.user_input']).toBe('test input');
  });

  it('ADK invocation span is a child of root span', async () => {
    const runner = createMockRunnerWithSpans(() => [makeFinalTextEvent('hello')]);
    await collectChunks(runAgent('test', runner, 'sess-1'));

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const rootSpan = getSpanByName(spans, 'solenoid.agent_run');
    const invocationSpan = getSpanByName(spans, 'invocation');

    expect(getParentSpanId(invocationSpan)).toBe(rootSpan.spanContext().spanId);
    expect(invocationSpan.spanContext().traceId).toBe(rootSpan.spanContext().traceId);
  });

  it('invoke_agent span nests under invocation span', async () => {
    const runner = createMockRunnerWithSpans(() => [makeFinalTextEvent('hello')]);
    await collectChunks(runAgent('test', runner, 'sess-2'));

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const invocationSpan = getSpanByName(spans, 'invocation');
    const agentSpan = getSpanByName(spans, 'invoke_agent test_agent');

    expect(getParentSpanId(agentSpan)).toBe(invocationSpan.spanContext().spanId);
    expect(agentSpan.spanContext().traceId).toBe(invocationSpan.spanContext().traceId);
  });

  it('execute_tool span nests under invoke_agent span', async () => {
    const runner = createMockRunnerWithSpans(() => [
      makeEvent({
        parts: [{ functionCall: { name: 'search', args: { q: 'test' } } }],
      }),
      makeFinalTextEvent('search results'),
    ]);
    await collectChunks(runAgent('search', runner, 'sess-3'));

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const agentSpan = getSpanByName(spans, 'invoke_agent test_agent');
    const toolSpan = getSpanByName(spans, 'execute_tool mock_tool');

    expect(getParentSpanId(toolSpan)).toBe(agentSpan.spanContext().spanId);
    expect(toolSpan.spanContext().traceId).toBe(agentSpan.spanContext().traceId);
  });

  it('full hierarchy: root > invocation > agent > tool (same trace)', async () => {
    const runner = createMockRunnerWithSpans(() => [
      makeEvent({
        parts: [{ functionCall: { name: 'tool', args: {} } }],
      }),
      makeFinalTextEvent('done'),
    ]);
    await collectChunks(runAgent('full trace', runner, 'sess-4'));

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const rootSpan = getSpanByName(spans, 'solenoid.agent_run');
    const invocationSpan = getSpanByName(spans, 'invocation');
    const agentSpan = getSpanByName(spans, 'invoke_agent test_agent');
    const toolSpan = getSpanByName(spans, 'execute_tool mock_tool');

    // All in same trace
    const traceId = rootSpan.spanContext().traceId;
    expect(invocationSpan.spanContext().traceId).toBe(traceId);
    expect(agentSpan.spanContext().traceId).toBe(traceId);
    expect(toolSpan.spanContext().traceId).toBe(traceId);

    // Correct parent chain
    expect(getParentSpanId(rootSpan)).toBeUndefined();
    expect(getParentSpanId(invocationSpan)).toBe(rootSpan.spanContext().spanId);
    expect(getParentSpanId(agentSpan)).toBe(invocationSpan.spanContext().spanId);
    expect(getParentSpanId(toolSpan)).toBe(agentSpan.spanContext().spanId);
  });

  it('spans are not orphaned into separate traces', async () => {
    const runner = createMockRunnerWithSpans(() => [makeFinalTextEvent('hello')]);
    await collectChunks(runAgent('orphan check', runner, 'sess-5'));

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    // All spans should share the same trace ID
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it('root span has ERROR status when runner exhausts retries', async () => {
    const runner = createMockRunnerWithSpans(() => [makeEvent({ parts: [] })]);
    await collectChunks(runAgent('will fail', runner, 'sess-6'));

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const rootSpans = getSpansByName(spans, 'solenoid.agent_run');
    expect(rootSpans).toHaveLength(1);
    expect(rootSpans[0]!.status.code).toBe(2); // SpanStatusCode.ERROR = 2
  });
});
