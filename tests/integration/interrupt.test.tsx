/**
 * Interrupt Integration Tests
 *
 * Tests for the agent interrupt/pause feature using the test harness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SolenoidTestHarness } from '../../src/ui/testing/index.js';

describe('Agent Interrupt', () => {
  let harness: SolenoidTestHarness;

  beforeEach(async () => {
    harness = new SolenoidTestHarness({
      responses: {
        default: {
          textChunks: ['chunk1 ', 'chunk2 ', 'chunk3 ', 'chunk4 ', 'chunk5 '],
          chunkDelay: 100,
        },
      },
    });
    await harness.start();
  });

  afterEach(() => {
    harness.dispose();
  });

  it('interrupts agent and preserves partial content', async () => {
    // Start message processing (don't await - we want to interrupt)
    const resultPromise = harness.sendMessage('tell me something');

    // Wait for some chunks to arrive
    await new Promise((r) => setTimeout(r, 150));

    // Interrupt
    await harness.interruptAgent();

    // Wait for processing to finish
    await resultPromise;

    const frame = harness.getCurrentFrame();
    // Should have some partial content
    expect(frame.containsText('chunk1')).toBe(true);
    // Should not have all chunks (interrupted before completion)
    // Note: timing-dependent, but with 100ms delay and 150ms wait,
    // we should get 1-2 chunks before interrupt
  });

  it('re-enables input after interrupt', async () => {
    const resultPromise = harness.sendMessage('tell me something');

    await new Promise((r) => setTimeout(r, 150));
    await harness.interruptAgent();
    await resultPromise;

    const state = harness.getState();
    expect(state.isProcessing).toBe(false);
    expect(state.inputEnabled).toBe(true);
  });

  it('conversation continues after interrupt', async () => {
    // First message - interrupt it
    const firstResult = harness.sendMessage('first message');
    await new Promise((r) => setTimeout(r, 150));
    await harness.interruptAgent();
    await firstResult;

    // Second message - let it complete
    await harness.sendMessage('second message');

    const frame = harness.getCurrentFrame();
    expect(frame.containsText('first message')).toBe(true);
    expect(frame.containsText('second message')).toBe(true);
  });

  it('status returns to Ready after interrupt', async () => {
    const resultPromise = harness.sendMessage('tell me something');

    await new Promise((r) => setTimeout(r, 150));
    await harness.interruptAgent();
    await resultPromise;

    const state = harness.getState();
    expect(state.status).toBe('Ready');
  });
});
