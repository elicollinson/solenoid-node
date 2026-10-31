/**
 * UI Entry Point
 *
 * Initializes and renders the terminal-based chat interface using Ink.
 * Harness initialization happens within the App component with a loading screen.
 *
 * Dependencies:
 * - ink: React for CLIs - builds terminal UIs with React components
 */
import { render } from 'ink';
import { initTracing, shutdownTracing } from '../telemetry/index.js';
import { setupErrorHandlers, uiLogger } from '../utils/logger.js';
import { App } from './app.js';
import { currentHarness } from './hooks/index.js';

setupErrorHandlers(uiLogger);
initTracing();

uiLogger.info('Starting Solenoid UI');

let exitCode = 0;
try {
  const instance = render(<App />);
  uiLogger.info('UI rendered successfully');
  await instance.waitUntilExit();
  uiLogger.info('UI exited normally');
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  uiLogger.fatal({ error: err.message, stack: err.stack }, 'UI crashed');
  exitCode = 1;
} finally {
  await currentHarness()?.close();
  await shutdownTracing();
  // Force exit — MCP connections and other async operations may keep process alive
  process.exit(exitCode);
}
