/**
 * Tool fixtures for harness tests.
 */
import { z } from 'zod';
import { type AgentTool, defineTool } from '../../src/core/index.js';

/** A read tool that takes nothing and answers `<name> ran`. */
export const readTool = (name: string): AgentTool =>
  defineTool({
    name,
    description: `The ${name} tool.`,
    kind: 'read',
    schema: z.object({}),
    execute: () => `${name} ran`,
  });

export const toolNames = (tools: readonly AgentTool[]) =>
  tools.map((t) => t.definition.function.name);
