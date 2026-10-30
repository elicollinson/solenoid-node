/**
 * Agent Tools
 *
 * A tool bundles everything about one capability in one place: the zod schema
 * (single source of truth) drives both runtime validation and the JSON schema
 * the model sees, so there is no separate definition to drift.
 *
 * Ported from Solenoid-Assistant src/core/tools.ts.
 */
import { type ToolKind, authoredText } from '@elicollinson/solenoid-security';
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
 * What a tool touches. Classify by effect, not by how the name reads.
 *
 * - `read` / `write` (solenoid-security's ToolKind): the tool reaches the
 *   world. A read observes it and cannot change anything a later read would
 *   see; a write changes it. Both return text from outside this process, so
 *   their output is screened before the model reads it. A write asks first
 *   (see `ApprovalHandler` in ./agent.ts) and, once run, keeps a failed
 *   attempt from being replayed on another route. When it is genuinely
 *   arguable whether a tool changes anything, it is a write.
 * - `internal`: the tool touches only this process. It returns what the model
 *   sent it plus this repository's literals (a chart drawn from its
 *   arguments, a table it wrote), so like the model's own turns its output
 *   is not screened, and with nothing outside to change it never asks.
 *
 * External is the default in the sense that matters: `internal` must be
 * claimed, and only when no byte of the output comes from anywhere else and
 * nothing outside this process is touched. MCP tools are never internal.
 * Reads and internal tools of one turn run concurrently.
 */
export type AgentToolKind = ToolKind | 'internal';

export interface ToolContext {
  signal?: AbortSignal;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  definition: FunctionToolDefinition;
  kind: AgentToolKind;
  schema: S;
  execute: (args: z.infer<S>, context: ToolContext) => unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(config: {
  name: string;
  description: string;
  /** Required: an unclassified tool would have to be assumed a write. */
  kind: AgentToolKind;
  schema: S;
  execute: (args: z.infer<S>, context: ToolContext) => unknown | Promise<unknown>;
}): AgentTool<S> {
  // Every description reaching this function is a literal in this repository,
  // which is the licence for registering it as authored text: the injection
  // screen subtracts it before looking, so our own imperative tool prose is
  // never mistaken for an attack. MCP tools are built by hand in
  // ../mcp/manager.ts precisely because a remote server's description is that
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
