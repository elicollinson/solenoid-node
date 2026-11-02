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
 * Deny anywhere wins, whichever key or rule set it is on: a capability denied
 * by the app is not reopened by one tool the person allowed. Otherwise the
 * most specific key decides (tool, then capability, then `*`), ask over allow
 * on a tie, and with no rule at all the answer is ask.
 */
import type { PERMISSION_MODES } from '../config/index.js';
import type { ApprovalHandler } from '../core/index.js';
import { declinedMessage } from './messages.js';

export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type PermissionRules = Readonly<Record<string, PermissionMode>>;

/**
 * A write tool's capability: its family, up to the first `_` or `-`, then
 * `.write`. `calendar_create` → `calendar.write`, `notion-create-pages` →
 * `notion.write`. Solenoid-Assistant names capabilities the same way, so a
 * rule written for one reads the same in the other.
 */
export function capabilityFor(tool: string): string {
  const cut = tool.search(/[_-]/);
  return `${cut > 0 ? tool.slice(0, cut) : tool}.write`;
}

/** What `rules` say about `tool` (see the top of this file). */
export function resolvePermission(rules: readonly PermissionRules[], tool: string): PermissionMode {
  const perKey = [tool, capabilityFor(tool), '*'].map((key) =>
    rules.flatMap((set) => (Object.hasOwn(set, key) ? [set[key] as PermissionMode] : []))
  );
  if (perKey.some((modes) => modes.includes('deny'))) return 'deny';
  const decided = perKey.find((modes) => modes.length);
  if (!decided) return 'ask';
  return decided.includes('ask') ? 'ask' : 'allow';
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
