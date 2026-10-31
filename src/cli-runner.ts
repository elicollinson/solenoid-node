/**
 * Non-Interactive CLI Runner
 *
 * Executes a single prompt and writes the answer, the final turn's text, to
 * stdout once that turn completes. Status and errors go to stderr, so stdout stays pipeable. Nobody
 * is present to approve a write tool, so writes are declined unless
 * `--yes` was given.
 */
import { loadSettings } from './config/index.js';
import { Session, createHarness, declinedMessage, describeRunError } from './harness/index.js';
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

    // Only the final turn's text is the answer. Text written before a tool
    // call ("Let me search for that") is narration, so only a turn without
    // tool calls reaches stdout. A retried or abandoned turn never completes,
    // so it never reports a turn to print.
    let printed = false;
    await new Session(harness.agent).send(prompt, {
      signal: controller.signal,
      approve: (request) =>
        options.yes
          ? { allow: true }
          : { allow: false, tell: declinedMessage(request.tool, 'unattended') },
      onEvent: (event) => {
        switch (event.type) {
          case 'route_advanced':
            process.stderr.write(
              `${event.from.provider} failed; retrying on ${event.to.provider}\n`
            );
            break;
          case 'assistant_turn':
            if (!event.message.toolCalls?.length && event.message.content) {
              process.stdout.write(event.message.content);
              printed = true;
            }
            break;
          case 'tool_start':
            process.stderr.write(`· ${event.name}\n`);
            break;
        }
      },
    });
    if (printed) process.stdout.write('\n');
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${describeRunError(error)}\n`);
    return 1;
  } finally {
    await close?.();
    await shutdownTracing();
  }
}
