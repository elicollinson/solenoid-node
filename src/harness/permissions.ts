/**
 * Approval Rules
 *
 * Standing answers to "may this write run?", so a person is not asked the
 * same question every time. The core only asks (Agent's `approve`); what the
 * answer is belongs to whoever runs the agent. This is the harness's answer,
 * read from settings and from the profile, and put in front of every
 * session's asker (Session's `policy`).
 *
 * A rule is keyed by a tool's name (`calendar_create`), its capability
 * (`calendar.write`), or `*`, and says one of:
 *
 *   allow  it runs without asking.
 *   ask    whoever would be asked is asked: the person, an app's `approve`,
 *          or nobody (declined).
 *   deny   it never runs, and the model is told so.
 *
 * Within one set of rules the most specific key decides: tool, then
 * capability, then `*`. So `*: deny` with `calendar.write: allow` denies
 * everything but calendar writes.
 *
 * Two sets meet at every write: the person's (settings) and the agent's (the
 * profile). The agent's deny is a hard limit, and so is the person's; past
 * that the person's own rule decides, since it is their choice to be asked or
 * not, then the agent's. With no rule in either, the answer is ask.
 */
import type { PERMISSION_MODES } from '../config/index.js';
import type { ApprovalHandler } from '../core/index.js';
import { declinedMessage } from './messages.js';

export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type PermissionRules = Readonly<Record<string, PermissionMode>>;

/**
 * A write tool's capability: its family, then `.write`. The family runs to
 * the first `_`, or failing one to the first `-`:
 *
 *   calendar_create              → calendar.write
 *   google-calendar_create_event → google-calendar.write (an MCP tool:
 *                                  `<server>_<tool>`, so the server)
 *   notion-create-pages          → notion.write
 *
 * Solenoid-Assistant names its own tools and MCP tools the same way, so a
 * rule written for one reads the same in the other. An MCP server whose name
 * holds a `_` splits early; name servers with `-`.
 */
export function capabilityFor(tool: string): string {
  const underscore = tool.indexOf('_');
  const cut = underscore > 0 ? underscore : tool.indexOf('-');
  return `${cut > 0 ? tool.slice(0, cut) : tool}.write`;
}

/** What one set of rules says about `tool`: its most specific key's mode, if any. */
function ruleFor(rules: PermissionRules, tool: string): PermissionMode | undefined {
  for (const key of [tool, capabilityFor(tool), '*']) {
    if (Object.hasOwn(rules, key)) return rules[key];
  }
  return undefined;
}

/** The person's and the agent's rules together (see the top of this file). */
export function resolvePermission(
  person: PermissionRules,
  agent: PermissionRules,
  tool: string
): PermissionMode {
  const mine = ruleFor(person, tool);
  const its = ruleFor(agent, tool);
  if (mine === 'deny' || its === 'deny') return 'deny';
  return mine ?? its ?? 'ask';
}

/** Put standing rules in front of `ask`: allow and deny are answered here, ask goes on. */
export function withPermissions(
  permission: (tool: string) => PermissionMode,
  ask: ApprovalHandler
): ApprovalHandler {
  return (request) => {
    const mode = permission(request.tool);
    if (mode === 'allow') return { allow: true };
    if (mode === 'deny') return { allow: false, tell: declinedMessage(request.tool, 'denied') };
    return ask(request);
  };
}
