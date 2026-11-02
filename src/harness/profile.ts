/**
 * Agent Profiles
 *
 * What one kind of agent is, declared in code: which tools it holds, what it
 * is told, whether it can spawn subagents and who approves its writes. The
 * CLI's agent is the default profile; an app built on the harness declares
 * its own (a workflow with a group of domain tools, say) and opens sessions
 * with it.
 *
 * Tools start from the harness's base set (built-ins plus every connected MCP
 * server), lose any the profile excludes and gain any it adds, held from the
 * start or in groups opened on demand. Tools the app owns, bound to its own
 * data, arrive through `tools` and `toolGroups`; the harness never imports
 * them.
 */
import { authoredText } from '@elicollinson/solenoid-security';
import type { AgentTool, ApprovalHandler } from '../core/index.js';
import type { PermissionRules } from './permissions.js';
import { type ToolGroup, toolGroupOpener } from './toolGroups.js';

export interface AgentProfile {
  /** Shown on spans and in logs. Defaults to `solenoid`. */
  name?: string;
  /**
   * Replaces the base system prompt (`agent.system_prompt`, else the default).
   * Build it from DEFAULT_SYSTEM_PROMPT to extend rather than replace, and
   * declare the profile with `defineProfile` so the screen knows you wrote it.
   */
  systemPrompt?: string;
  /** Tools added to the base set. To replace a base tool, exclude it and add your own. */
  tools?: AgentTool[];
  /** Base tools this agent does not get, by name. A name the base set lacks is an error. */
  exclude?: string[];
  /**
   * Groups the agent opens when it needs them (./toolGroups.ts). Each starts
   * closed; to hold one open from the start, pass its tools in `tools`.
   */
  toolGroups?: ToolGroup[];
  /**
   * Hold no write tool at all: base, own and group tools alike. For an agent
   * that reads text a stranger wrote, so that text cannot steer it into a
   * change. Briefings list only the tools left; a group left with none is
   * dropped. Write a group's briefing about acts, not write tools by name.
   */
  readOnly?: boolean;
  /** Hold the subagent tools. Children get this profile's tools, prompt and rules. */
  canSpawn?: boolean;
  /**
   * Standing rules for this agent's writes (./permissions.ts), checked
   * together with the person's from settings. A deny in either is final;
   * otherwise the person's rule decides, then these.
   */
  permissions?: PermissionRules;
  /**
   * Who answers a write the rules leave at ask: by default the person, through
   * an interrupt. The rules always answer first, so an app that decides every
   * write itself runs with no `approvals.rules` and no `permissions`.
   */
  approve?: ApprovalHandler;
}

/**
 * Declare a profile once, where its prompt is written: the prompt is
 * registered as authored text, so the injection screen subtracts it. Only for
 * a literal of the app's own code; a prompt with data interpolated into it
 * would whitelist that data. A profile not declared this way still works, and
 * its prompt is screened like any text nobody vouched for.
 */
export function defineProfile(profile: AgentProfile): AgentProfile {
  if (profile.systemPrompt !== undefined) {
    authoredText.offer(`prompt:${profile.name ?? 'profile'}`, profile.systemPrompt);
  }
  return profile;
}

const nameOf = (tool: AgentTool) => tool.definition.function.name;

/**
 * What the agent holds from the start: the base tools less the excluded ones,
 * the profile's own, and the opener of its groups; with `readOnly`, none of
 * them a write. A name clash anywhere, group tools included, is refused by
 * Agent.addTool when the session opens.
 */
export function profileTools(base: readonly AgentTool[], profile: AgentProfile): AgentTool[] {
  const excluded = new Set(profile.exclude);
  const kept = base.filter((tool) => !excluded.delete(nameOf(tool)));
  if (excluded.size) {
    throw new Error(
      `Cannot exclude ${[...excluded].join(', ')}: the base tools are ${base.map(nameOf).join(', ')}`
    );
  }
  const allowed = (tools: readonly AgentTool[]) =>
    profile.readOnly ? tools.filter((tool) => tool.kind !== 'write') : [...tools];
  // Filtered before the opener is built, so its description and briefings
  // never name a write tool.
  const groups = (profile.toolGroups ?? [])
    .map((group) => ({ ...group, tools: allowed(group.tools) }))
    .filter((group) => group.tools.length);
  const opener = toolGroupOpener(groups);
  const held = [...allowed(kept), ...allowed(profile.tools ?? []), ...(opener ? [opener] : [])];
  // Read-only reaches whatever a held tool can unlock, not only groups.
  return held.map((tool) => {
    const { unlocks } = tool;
    if (!profile.readOnly || !unlocks) return tool;
    return {
      ...tool,
      unlocks: {
        tools: allowed(unlocks.tools),
        unlocked: (messages) => allowed(unlocks.unlocked(messages)),
      },
    };
  });
}
