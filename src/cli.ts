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
import { runNonInteractive } from './cli-runner.js';
import { ensureSettingsFile } from './config/index.js';

program
  .name('solenoid')
  .description('Multi-agent AI assistant with local LLM inference')
  .version('2.0.0-alpha.1')
  .option('-r, --run <prompt>', 'Run a prompt non-interactively and print the output to stdout')
  .action(async (options) => {
    if (options.run) {
      // Non-interactive mode
      const exitCode = await runNonInteractive(options.run);
      process.exit(exitCode);
    } else {
      // Interactive UI mode
      ensureSettingsFile();
      await import('./ui/index.js');
    }
  });

program.parse();
