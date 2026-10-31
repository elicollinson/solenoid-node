import { EventType } from '@ag-ui/core';
/**
 * Non-Interactive CLI Runner
 *
 * Executes a single prompt and writes the answer to stdout once the agent
 * has given it. Status and errors go to stderr, so stdout stays pipeable.
 * Nobody is present to answer an approval interrupt, so writes are declined
 * unless `--yes` was given.
 */
import { loadSettings } from './config/index.js';
import {
  CUSTOM_EVENTS,
  Session,
  approvalAnswer,
  createHarness,
  customValue,
  describeRouteAdvance,
  describeRunError,
} from './harness/index.js';
import { initTracing, shutdownTracing } from './telemetry/index.js';
import { setupErrorHandlers, uiLogger } from './utils/logger.js';

export interface NonInteractiveOptions {
  /** Allow write tools without asking. */
  yes?: boolean;
}

/**
 * Run a prompt non-interactively. Returns the process exit code.
 */
export async function runNonInteractive(
  prompt: string,
  options: NonInteractiveOptions = {}
): Promise<number> {
  setupErrorHandlers(uiLogger);
  initTracing();

  let close: (() => Promise<void>) | undefined;
  try {
    const harness = await createHarness(loadSettings());
    close = harness.close;
    for (const warning of harness.warnings) {
      process.stderr.write(`warning: ${warning}\n`);
    }

    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());

    // Nobody is here to answer an approval: --yes allows it, and otherwise
    // it is cancelled, which the agent hears as an unattended decline.
    const session = new Session(harness.agent);
    const answer = await session.send(prompt, {
      signal: controller.signal,
      onEvent: (event) => {
        const route = customValue(event, CUSTOM_EVENTS.routeAdvanced);
        if (event.type === EventType.TOOL_CALL_START) {
          process.stderr.write(`· ${event.toolCallName}\n`);
        } else if (route) {
          process.stderr.write(`${describeRouteAdvance(route)}\n`);
        } else if (event.type === EventType.RUN_FINISHED && event.outcome?.type === 'interrupt') {
          session.resume(
            event.outcome.interrupts.map((i) =>
              approvalAnswer(i.id, options.yes ? 'allow' : 'unattended')
            )
          );
        }
      },
    });
    // The answer is the final reply's text; text written before a tool call
    // ("Let me search for that") is narration and stays off stdout.
    if (answer) process.stdout.write(`${answer}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${describeRunError(error)}\n`);
    return 1;
  } finally {
    await close?.();
    await shutdownTracing();
  }
}
