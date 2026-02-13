/**
 * UI Entry Point
 *
 * Initializes and renders the terminal-based chat interface using Ink.
 * Agent initialization happens within the App component with a loading screen.
 *
 * Dependencies:
 * - ink: React for CLIs - builds terminal UIs with React components
 */
import { LogLevel, setLogLevel } from '@google/adk';
import { render } from 'ink';
import { initTracing, shutdownTracing } from '../telemetry/index.js';
import { setupErrorHandlers, uiLogger } from '../utils/logger.js';
import { App } from './app.js';

// Suppress ADK console logs — must be called before any ADK code runs
setLogLevel((LogLevel.ERROR + 1) as unknown as LogLevel);

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
  await shutdownTracing();
  // Force exit — MCP connections and other async operations may keep process alive
  process.exit(exitCode);
}
