/**
 * CLI Runner - Non-Interactive Execution
 *
 * Handles non-interactive prompt execution for the CLI. Initializes the
 * agent system, runs the prompt, collects output, and exits cleanly.
 *
 * Features:
 * - Plain text output to stdout
 * - Complete response before output (no streaming)
 * - Error messages to stderr
 * - Proper cleanup and exit codes
 */
import { LogLevel, setLogLevel } from '@google/adk';
import { createAdkAgentHierarchy, runAgent } from './agents/index.js';
import { ensureSettingsFile, tryLoadSettings } from './config/index.js';
import { initTracing, shutdownTracing } from './telemetry/index.js';
import { agentLogger } from './utils/logger.js';

// Suppress ADK console logs — must be called before any ADK code runs
setLogLevel((LogLevel.ERROR + 1) as unknown as LogLevel);

/**
 * Run a prompt non-interactively and print output to stdout.
 *
 * @param prompt - The prompt to send to the agent
 * @returns Exit code (0 for success, 1 for error)
 */
export async function runNonInteractive(prompt: string): Promise<number> {
  // Initialize settings (non-fatal if missing)
  const settingsPath = ensureSettingsFile();
  if (!settingsPath) {
    agentLogger.warn('No settings file found, using defaults');
  } else {
    agentLogger.debug({ path: settingsPath }, 'Settings file loaded');
  }

  // Initialize telemetry (optional, will be no-op if no WANDB keys)
  initTracing();

  try {
    agentLogger.info('Initializing agent hierarchy...');
    const { runner } = await createAdkAgentHierarchy();
    agentLogger.info('Agent ready');

    // Run the agent and collect complete response
    const response = await collectResponse(prompt, runner);

    // Print output to stdout
    console.log(response);

    agentLogger.info('Prompt completed successfully');
    return 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    agentLogger.error({ error: errorMessage }, 'Prompt failed');

    // Print error to stderr
    console.error(`Error: ${errorMessage}`);
    return 1;
  } finally {
    // Always cleanup telemetry
    await shutdownTracing();
  }
}

/**
 * Run the agent and collect the complete response.
 * Waits for the full response before returning.
 * Filters out planning output and duplicate text from parent agents.
 */
async function collectResponse(
  prompt: string,
  runner: Awaited<ReturnType<typeof createAdkAgentHierarchy>>['runner']
): Promise<string> {
  const parts: string[] = [];
  let seenNonPlanText = false;

  for await (const chunk of runAgent(prompt, runner)) {
    switch (chunk.type) {
      case 'text':
        if (!chunk.content) break;

        // Skip the initial planning output from planning_agent
        if (chunk.content.startsWith('PLAN:')) {
          break;
        }

        // After we've seen the first real content, don't collect any more
        // This filters out duplicate text when planning_agent echoes the sub-agent's response
        if (seenNonPlanText) {
          break;
        }

        parts.push(chunk.content);
        seenNonPlanText = true;
        break;
      case 'transfer':
        // Transfers are informational only
        break;
      case 'error':
        throw new Error(chunk.error);
      case 'done':
        break;
    }
  }

  return parts.join('');
}
