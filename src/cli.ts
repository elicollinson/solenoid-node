#!/usr/bin/env node
/**
 * CLI Entry Point
 *
 * Main command-line interface for Solenoid. Single command that starts
 * the terminal UI with integrated agent system.
 *
 * Dependencies:
 * - commander: Declarative CLI argument parsing and command definitions
 */
import { program } from 'commander';
import { ensureSettingsFile } from './config/index.js';

program
  .name('solenoid')
  .description('Multi-agent AI assistant with local LLM inference')
  .version('2.0.0-alpha.1')
  .action(async () => {
    ensureSettingsFile();
    await import('./ui/index.js');
  });

program.parse();
