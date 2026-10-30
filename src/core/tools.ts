/**
 * Agent Tools
 *
 * A tool bundles everything about one capability in one place: the zod schema
 * (single source of truth) drives both runtime validation and the JSON schema
 * the model sees, so there is no separate definition to drift.
 *
 * Ported from Solenoid-Assistant src/core/tools.ts.
 */
import { authoredText } from '@elicollinson/solenoid-security';
import { z } from 'zod';

export interface FunctionToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Whether a tool observes or changes the world.
 *
 * "read" means it cannot change anything a later read would see. Classify by
 * effect, not by how the name reads; when it is genuinely arguable, it is a
 * write. The agent asks before a write runs (see `ApprovalHandler` in
 * ./agent.ts) and never before a read.
 */
export type ToolKind = 'read' | 'write';

export interface ToolContext {
  signal?: AbortSignal;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  definition: FunctionToolDefinition;
  kind: ToolKind;
  schema: S;
  execute: (args: z.infer<S>, context: ToolContext) => unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(config: {
  name: string;
  description: string;
  /** Required: an unclassified tool would have to be assumed a write. */
  kind: ToolKind;
  schema: S;
  execute: (args: z.infer<S>, context: ToolContext) => unknown | Promise<unknown>;
}): AgentTool<S> {
  // Every description reaching this function is a literal in this repository,
  // which is the licence for registering it as authored text: the injection
  // screen subtracts it before looking, so our own imperative tool prose is
  // never mistaken for an attack. MCP tools are built by hand in
  // ../tools/mcp.ts precisely because a remote server's description is that
  // server's text, not ours. Never route interpolated text through here.
  authoredText.offer(`tool:${config.name}`, config.description);
  return {
    kind: config.kind,
    schema: config.schema,
    execute: config.execute,
    definition: {
      type: 'function',
      function: {
        name: config.name,
        description: config.description,
        parameters: toJsonSchema(config.schema),
      },
    },
  };
}

/** zod → JSON schema, without the meta-schema pointer backends don't want. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _metaSchema, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json;
}
