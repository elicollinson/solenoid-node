/**
 * Tool Groups
 *
 * Tools an agent opens rather than holds. Forty tool definitions spend a
 * local model's context before it has read the task, so a profile can hand
 * its agent groups instead: each starts closed, known to the model only by a
 * one-line summary in the description of a single tool, `open_tool_group`.
 * Opening one answers with the group's briefing (what it is for, how to use
 * it, the tools it holds) and makes its tools callable from the next turn.
 *
 * Which groups are open is read off the transcript: a group is open once the
 * conversation holds a completed call that opened it. Nothing is held, so the
 * answer stays right across the turns of a session, after `clear`, and when a
 * failed attempt is replayed on another route without the call that opened it.
 * The core knows nothing of groups: the opener is a tool that unlocks tools.
 *
 * Ported in spirit from Solenoid-Assistant src/core/toolGroups.ts, with one
 * opener rather than a loader per group.
 */
import { authoredText } from '@elicollinson/solenoid-security';
import { z } from 'zod';
import { type AgentTool, type ChatMessage, type Unlocks, defineTool } from '../core/index.js';

export const OPEN_TOOL_GROUP = 'open_tool_group';

export interface ToolGroup {
  /** Lowercase snake_case: what the model passes to open it. */
  name: string;
  /**
   * The one line the model sees while the group is closed, and its whole
   * basis for opening it: say what the group is for, not what its tools do.
   */
  summary: string;
  /**
   * What the model reads when it opens the group: what the data is, the
   * order things happen in, what must never be done. The tool list is added
   * after it. Name acts rather than tools, so it stays true of the group.
   */
  briefing: string;
  tools: readonly AgentTool[];
}

const NAME = /^[a-z][a-z0-9_]*$/;

/**
 * A group, declared where it is written. Its briefing is registered as
 * authored text, so the injection screen subtracts it (the summary is, as
 * part of the opener's description): only for literals of the app's own
 * code, never text with data interpolated.
 */
export function defineToolGroup(group: ToolGroup): ToolGroup {
  if (!NAME.test(group.name)) {
    throw new Error(`Tool group "${group.name}" must be lowercase snake_case`);
  }
  if (!group.tools.length) throw new Error(`Tool group "${group.name}" has no tools`);
  authoredText.offer(`group:${group.name}`, group.briefing);
  return group;
}

/** What opening a group answers with: its briefing, then its tools. */
function briefingOf(group: ToolGroup): string {
  const tools = group.tools.map((tool) => {
    const { name, description } = tool.definition.function;
    return `- ${name}: ${description.split('\n')[0]}`;
  });
  return `${group.briefing}\n\nTools now available:\n${tools.join('\n')}`;
}

/** The groups a transcript has opened, in the order it opened them. */
function openedIn(messages: readonly ChatMessage[], groups: Map<string, ToolGroup>): ToolGroup[] {
  const answered = new Set(messages.map((m) => m.toolCallId));
  const open = new Set<ToolGroup>();
  for (const call of messages.flatMap((m) => m.toolCalls ?? [])) {
    if (call.name !== OPEN_TOOL_GROUP || !answered.has(call.id)) continue;
    const group = groups.get((call.arguments as { group?: unknown } | null)?.group as string);
    if (group) open.add(group);
  }
  return [...open];
}

/**
 * The one tool that opens any of `groups`, carrying their tools as what it
 * unlocks (AgentTool.unlocks), so the agent checks every name when it is
 * built. Undefined when there are no groups.
 */
export function toolGroupOpener(groups: readonly ToolGroup[]): AgentTool | undefined {
  if (!groups.length) return undefined;
  const byName = new Map(groups.map((group) => [group.name, group]));
  if (byName.size !== groups.length) throw new Error('Two tool groups share a name');

  const opener = defineTool({
    name: OPEN_TOOL_GROUP,
    description: `Open a group of tools when the task needs them. Its tools become callable from your next turn, and it answers with how to use them. Groups:\n${groups.map((g) => `- ${g.name}: ${g.summary}`).join('\n')}`,
    kind: 'internal',
    schema: z.object({
      group: z.enum([...byName.keys()] as [string, ...string[]]).describe('The group to open'),
    }),
    execute: ({ group }) => briefingOf(byName.get(group)!),
  });
  const unlocks: Unlocks = {
    tools: groups.flatMap((group) => group.tools),
    unlocked: (messages) => openedIn(messages, byName).flatMap((group) => group.tools),
  };
  return { ...opener, unlocks } as AgentTool;
}
