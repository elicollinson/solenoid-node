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
 * server), lose any the profile excludes and gain any it adds. Tools the app
 * owns, bound to its own data, arrive through `tools`; the harness never
 * imports them.
 */
import { authoredText } from '@elicollinson/solenoid-security';
import type { AgentTool, ApprovalHandler } from '../core/index.js';

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
  /** Hold the subagent tools. Children get this profile's tools and prompt. */
  canSpawn?: boolean;
  /** How writes are approved (see SessionOptions). */
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

/** The base tools less the excluded ones, plus the profile's own. */
export function profileTools(base: readonly AgentTool[], profile: AgentProfile): AgentTool[] {
  const excluded = new Set(profile.exclude);
  const kept = base.filter((tool) => !excluded.delete(tool.definition.function.name));
  if (excluded.size) {
    throw new Error(
      `Cannot exclude ${[...excluded].join(', ')}: the base tools are ${base.map((t) => t.definition.function.name).join(', ')}`
    );
  }
  // A name clash with a kept tool is refused by Agent.addTool.
  return [...kept, ...(profile.tools ?? [])];
}
