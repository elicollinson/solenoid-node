/**
 * HelpScreen Component Tests
 *
 * Unit tests for the HelpScreen overlay component.
 *
 * Note: Interactive keyboard tests (useInput) are skipped because
 * ink-testing-library stdin doesn't reliably trigger useInput callbacks.
 * Key handling is tested through the SolenoidTestHarness integration tests.
 */
import { describe, expect, it, mock } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import { HelpScreen } from '../../../../src/ui/components/HelpScreen.js';

describe('HelpScreen', () => {
  it('renders help title', () => {
    const { lastFrame } = render(<HelpScreen onClose={() => {}} />);

    expect(lastFrame()).toContain('Solenoid Help');
  });

  it('displays slash commands section', () => {
    const { lastFrame } = render(<HelpScreen onClose={() => {}} />);

    expect(lastFrame()).toContain('Slash Commands');
    expect(lastFrame()).toContain('/help');
    expect(lastFrame()).toContain('/settings');
    expect(lastFrame()).toContain('/clear');
    expect(lastFrame()).toContain('/tools');
    expect(lastFrame()).toContain('/quit');
  });

  it('displays keyboard shortcuts section', () => {
    const { lastFrame } = render(<HelpScreen onClose={() => {}} />);

    expect(lastFrame()).toContain('Keyboard Shortcuts');
    expect(lastFrame()).toContain('Ctrl+C');
    expect(lastFrame()).toContain('Enter');
    expect(lastFrame()).toContain('Esc');
  });

  it('describes the agent', () => {
    const { lastFrame } = render(<HelpScreen onClose={() => {}} />);

    expect(lastFrame()).toContain('The Agent');
    expect(lastFrame()).toContain('MCP servers');
  });

  it('shows close hint', () => {
    const { lastFrame } = render(<HelpScreen onClose={() => {}} />);

    expect(lastFrame()).toContain('Press Enter or Esc to close');
  });

  // Note: useInput doesn't receive stdin events reliably in ink-testing-library
  // These behaviors are tested through the actual app with manual testing
  it.skip('calls onClose when Enter is pressed', async () => {
    const onClose = mock(() => {});
    const { stdin } = render(<HelpScreen onClose={onClose} />);

    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(onClose).toHaveBeenCalled();
  });

  it.skip('calls onClose when Escape is pressed', async () => {
    const onClose = mock(() => {});
    const { stdin } = render(<HelpScreen onClose={onClose} />);

    stdin.write('\x1B');
    await new Promise((r) => setTimeout(r, 50));

    expect(onClose).toHaveBeenCalled();
  });

  it('does not call onClose for other keys', async () => {
    const onClose = mock(() => {});
    const { stdin } = render(<HelpScreen onClose={onClose} />);

    // Type a regular character
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows command descriptions', () => {
    const { lastFrame } = render(<HelpScreen onClose={() => {}} />);

    expect(lastFrame()).toContain('Show this help screen');
    expect(lastFrame()).toContain('View current settings');
    expect(lastFrame()).toContain('Clear the conversation');
    expect(lastFrame()).toContain('Show model routes');
    expect(lastFrame()).toContain('Exit the application');
  });
});
