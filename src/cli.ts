#!/usr/bin/env bun
/**
 * CLI Entry Point
 *
 * Main command-line interface for Solenoid. Supports two modes:
 * - Interactive mode (default): Terminal UI with integrated agent system
 * - Non-interactive mode (--run): Execute a prompt and print output to stdout
 *
 * Dependencies:
 * - commander: Declarative CLI argument parsing and command definitions
 */
import { program } from 'commander';
import { version } from '../package.json';
import { runNonInteractive } from './cli-runner.js';
import { ensureSettingsFile } from './config/index.js';

program
  .name('solenoid')
  .description('Single-agent AI harness for LM Studio and OpenRouter models')
  .version(version)
  .option('-r, --run <prompt>', 'Run a prompt non-interactively and print the output to stdout')
  .option('-y, --yes', 'With --run: allow tools that change things without asking')
  .option('-c, --continue', 'Resume the most recent saved session')
  .option('--resume <session-id>', 'Resume a saved session by ID or prefix')
  .action(async (options) => {
    const resume =
      typeof options.resume === 'string' ? options.resume : options.continue ? true : undefined;
    if (options.run) {
      // Non-interactive mode
      ensureSettingsFile();
      const exitCode = await runNonInteractive(options.run, {
        yes: Boolean(options.yes),
        resume,
      });
      process.exit(exitCode);
    } else {
      // Interactive UI mode
      ensureSettingsFile();
      if (resume) {
        process.env.SOLENOID_RESUME_SESSION = typeof resume === 'string' ? resume : '__latest__';
      }
      await import('./ui/index.js');
    }
  });

program.parse();
