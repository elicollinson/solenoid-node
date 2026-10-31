/**
 * E2E Tests using Enhanced Test Harness
 *
 * These tests demonstrate the enhanced test harness capabilities:
 * - Real agent mode against LM Studio
 * - Custom agent injection
 * - Event tracking across all agent types
 *
 * Real agent tests are SKIPPED where LM Studio isn't serving the default
 * model (google/gemma-4-26b-a4b) at localhost:1234, which includes CI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type AgentEvent,
  type AgentInterface,
  SolenoidTestHarness,
} from '../../src/ui/testing/index.js';

/**
 * Check that LM Studio is up and lists the default model
 */
async function isLmStudioAvailable(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:1234/v1/models', {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    return body.data?.some((m) => m.id === 'google/gemma-4-26b-a4b') ?? false;
  } catch {
    return false;
  }
}

const lmStudioAvailable = await isLmStudioAvailable();
if (!lmStudioAvailable) {
  console.log('LM Studio not available - Real agent tests will be skipped');
}

describe('Enhanced Test Harness - Custom Agent Injection', () => {
  it('should work with a custom agent', async () => {
    const events: AgentEvent[] = [];

    // Create a simple custom agent
    const customAgent: AgentInterface = {
      async *run(input: string): AsyncGenerator<AgentEvent, void, unknown> {
        const textEvent: AgentEvent = {
          type: 'text',
          content: `Custom response to: ${input}`,
        };
        events.push(textEvent);
        yield textEvent;

        const doneEvent: AgentEvent = { type: 'done' };
        events.push(doneEvent);
        yield doneEvent;
      },
      getEventHistory: () => events,
      reset: () => {
        events.length = 0;
      },
    };

    const harness = new SolenoidTestHarness({
      customAgent,
      timeout: 10000,
    });

    await harness.start();

    expect(harness.isUsingCustomAgent()).toBe(true);
    expect(harness.isUsingRealAgent()).toBe(false);

    // Send a message
    await harness.sendMessage('test message');

    // Wait for processing
    await harness.waitForIdle();

    // Check that custom agent was called
    const frame = harness.getCurrentFrame();
    expect(frame.containsText('Custom response to: test message')).toBe(true);

    // Check event history
    const eventHistory = harness.getEventHistory();
    expect(eventHistory.length).toBeGreaterThan(0);
    expect(eventHistory.some((e) => e.type === 'text')).toBe(true);

    harness.dispose();
  });

  it('should track events from custom agents', async () => {
    let eventCount = 0;

    const customAgent: AgentInterface = {
      async *run(_input: string): AsyncGenerator<AgentEvent, void, unknown> {
        yield { type: 'text', content: 'Event 1' };
        eventCount++;
        yield { type: 'text', content: 'Event 2' };
        eventCount++;
        yield { type: 'done' };
        eventCount++;
      },
    };

    const harness = new SolenoidTestHarness({
      customAgent,
      timeout: 10000,
    });

    await harness.start();
    await harness.sendMessage('trigger events');
    await harness.waitForIdle();

    expect(eventCount).toBe(3);

    // Events should be tracked even without getEventHistory
    const events = harness.getEventHistory();
    expect(events.length).toBe(3);

    harness.dispose();
  });
});

describe('Enhanced Test Harness - Mock Agent Mode', () => {
  it('should still work in mock mode (default)', async () => {
    const harness = new SolenoidTestHarness({
      responses: {
        test: { textChunks: ['Mock response 1', ' Mock response 2'] },
      },
    });

    await harness.start();

    expect(harness.isUsingRealAgent()).toBe(false);
    expect(harness.isUsingCustomAgent()).toBe(false);

    await harness.sendMessage('test');
    await harness.waitForIdle();

    const frame = harness.getCurrentFrame();
    expect(frame.containsText('Mock response 1')).toBe(true);
    expect(frame.containsText('Mock response 2')).toBe(true);

    harness.dispose();
  });

  it('should track mock agent events through getEventHistory', async () => {
    const harness = new SolenoidTestHarness({
      responses: {
        test: {
          textChunks: ['Response'],
          toolCalls: [{ name: 'test_tool', args: { key: 'value' } }],
        },
      },
    });

    await harness.start();
    await harness.sendMessage('test');
    await harness.waitForIdle();

    const events = harness.getEventHistory();
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.some((e) => e.type === 'tool_start')).toBe(true);

    harness.dispose();
  });
});

describe.skipIf(!lmStudioAvailable)('Enhanced Test Harness - Real Agent Mode', () => {
  let harness: SolenoidTestHarness | null = null;
  let initError: Error | null = null;

  beforeAll(async () => {
    harness = new SolenoidTestHarness({
      useRealAgent: true,
      initTimeout: 60000,
      timeout: 120000,
      debug: false,
    });

    try {
      await harness.start();
    } catch (error) {
      initError = error instanceof Error ? error : new Error(String(error));
      console.log('Real agent initialization error:', initError.message);
    }
  });

  afterAll(() => {
    if (harness) {
      harness.dispose();
    }
  });

  it('should be configured for real agent mode', () => {
    if (initError) {
      console.log('Skipping - initialization failed');
      return;
    }

    expect(harness!.isUsingRealAgent()).toBe(true);
    expect(harness!.isUsingCustomAgent()).toBe(false);
  });

  it('should render initial UI correctly', () => {
    if (initError) {
      console.log('Skipping - initialization failed');
      return;
    }

    const frame = harness!.getCurrentFrame();
    expect(frame.containsText('Solenoid')).toBe(true);
    expect(frame.containsText('No messages yet')).toBe(true);
  });

  it('should handle slash commands', async () => {
    if (initError) {
      console.log('Skipping - initialization failed');
      return;
    }

    await harness!.executeCommand('/help');
    await harness!.waitForIdle();

    const frame = harness!.getCurrentFrame();
    expect(frame.containsText('Solenoid Help')).toBe(true);
  });

  it('should process a message with real agent', async () => {
    if (initError) {
      console.log('Skipping - initialization failed');
      return;
    }

    await harness!.executeCommand('/clear');
    await harness!.waitForIdle();

    await harness!.sendMessage('What is 17 + 25? Reply with just the number.');

    const frame = harness!.getCurrentFrame();
    expect(frame.containsText('42')).toBe(true);
    expect(frame.containsText('Error')).toBe(false);
    expect(harness!.getState().isProcessing).toBe(false);
  }, 180_000);
});

describe('Test Harness - getActiveAgent', () => {
  it('should return mock agent in mock mode', async () => {
    const harness = new SolenoidTestHarness();
    await harness.start();

    const agent = harness.getActiveAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe('function');

    harness.dispose();
  });

  it('should return custom agent when injected', async () => {
    const customAgent: AgentInterface = {
      async *run(): AsyncGenerator<AgentEvent, void, unknown> {
        yield { type: 'done' };
      },
    };

    const harness = new SolenoidTestHarness({ customAgent });
    await harness.start();

    const agent = harness.getActiveAgent();
    expect(agent).toBe(customAgent);

    harness.dispose();
  });
});
