/**
 * Tool fixtures for harness tests.
 */
import { z } from 'zod';
import {
  type AgentTool,
  type AgentToolKind,
  type ToolContext,
  defineTool,
  toolName,
} from '../../src/core/index.js';

/** A tool that takes nothing and answers `<name> ran`. */
const fixtureTool =
  (kind: AgentToolKind) =>
  (name: string): AgentTool =>
    defineTool({
      name,
      description: `The ${name} tool.`,
      kind,
      schema: z.object({}),
      execute: () => `${name} ran`,
    });

export const readTool = fixtureTool('read');
export const writeTool = fixtureTool('write');

export const toolNames = (tools: readonly AgentTool[]) => tools.map(toolName);

/** The context a tool runs with, for calling `execute` outside an agent. */
export const toolContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  offered: new Map(),
  messages: [],
  commit: () => {},
  ...overrides,
});
