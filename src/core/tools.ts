/**
 * Agent Tools
 *
 * A tool bundles everything about one capability in one place: the zod schema
 * (single source of truth) drives both runtime validation and the JSON schema
 * the model sees, so there is no separate definition to drift.
 *
 * Ported from Solenoid-Assistant src/core/tools.ts.
 */
import {
  type ToolKind,
  type ToolRequest,
  type ToolVerdict,
  authoredText,
} from '@elicollinson/solenoid-security';
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
 *   (see `ApprovalHandler` below) and, once run, keeps a failed
 *   attempt from being replayed on another route. When it is genuinely
 *   arguable whether a tool changes anything, it is a write.
 * - `internal`: the tool touches only this process. It returns what the model
 *   sent it plus this repository's literals, so like the model's own turns
 *   its output is not screened, and with nothing outside to change it never
 *   asks.
 * - `display`: an internal tool whose result is for the person, not the
 *   model, such as a chart. What `execute` returns is the content of the
 *   tool's `component`, reported as a `display` event; the model is told
 *   only that it was shown. Every display call also takes a required
 *   `done`: the model's own word that the call completes its answer.
 *
 * `internal` and `display` must be claimed, and only when no byte of the
 * output comes from anywhere else. MCP tools are never either. Anything but a
 * write runs concurrently with the other calls of its turn.
 */
export type AgentToolKind = ToolKind | 'internal' | 'display';

/**
 * Whether a tool reaches outside this process: its output is screened and it
 * may be put to approval. Everything but `internal` and `display`, so a kind
 * added later is screened until it says otherwise.
 */
export function reachesWorld(kind: AgentToolKind): kind is ToolKind {
  return kind !== 'internal' && kind !== 'display';
}

/**
 * solenoid-security's tool request, plus the run's signal. `args` are
 * validated: a call that fails its schema is refused before anybody is asked.
 */
export interface ApprovalRequest extends ToolRequest {
  /** The model's id for this call, as on its `tool_start` event. */
  toolCallId: string;
  /** The run's signal. An approval outlives no run. */
  signal: AbortSignal;
}

/** Allowed, or refused with the sentence the model is given. */
export type ApprovalHandler = (request: ApprovalRequest) => ToolVerdict | Promise<ToolVerdict>;

/** The argument by which a display call says it completes the answer. */
const DONE = z
  .boolean()
  .describe(
    'true if this completes your answer: your reply ends with this turn, so write the text of your answer in this same turn. false if you have more to show or say.'
  );

export interface ToolContext {
  signal?: AbortSignal;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  definition: FunctionToolDefinition;
  kind: AgentToolKind;
  /** A display tool's component type, which a surface draws its content with. */
  component?: string;
  schema: S;
  execute: (args: z.infer<S>, context: ToolContext) => unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(config: {
  name: string;
  description: string;
  /** Required: an unclassified tool would have to be assumed a write. */
  kind: AgentToolKind;
  /** Required for a display tool: the component type its content is. */
  component?: string;
  schema: S;
  execute: (args: z.infer<S>, context: ToolContext) => unknown | Promise<unknown>;
}): AgentTool<S> {
  if ((config.kind === 'display') !== Boolean(config.component)) {
    throw new Error(
      `Tool "${config.name}": a display tool, and only a display tool, names a component`
    );
  }
  // Every description reaching this function is a literal in this repository,
  // which is the licence for registering it as authored text: the injection
  // screen subtracts it before looking, so our own imperative tool prose is
  // never mistaken for an attack. MCP tools are built by hand in
  // ../mcp/manager.ts precisely because a remote server's description is that
  // server's text, not ours. Never route interpolated text through here.
  authoredText.offer(`tool:${config.name}`, config.description);
  // A display tool's schema gains `done`; the loop takes it off the
  // arguments before `execute` sees them.
  const schema =
    config.kind === 'display'
      ? (config.schema as unknown as z.ZodObject).extend({ done: DONE })
      : config.schema;
  return {
    kind: config.kind,
    ...(config.component ? { component: config.component } : {}),
    schema: schema as S,
    execute: config.execute,
    definition: {
      type: 'function',
      function: {
        name: config.name,
        description: config.description,
        parameters: toJsonSchema(schema),
      },
    },
  };
}

/** zod → JSON schema, without the meta-schema pointer backends don't want. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _metaSchema, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json;
}
