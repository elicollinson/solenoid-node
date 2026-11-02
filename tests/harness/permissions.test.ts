/**
 * Approval rules and read-only profiles. No network.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AppSettingsSchema } from '../../src/config/index.js';
import { Agent, type AgentTool, type ApprovalRequest, defineTool } from '../../src/core/index.js';
import {
  OPEN_TOOL_GROUP,
  Session,
  capabilityFor,
  defineToolGroup,
  profileTools,
  resolvePermission,
  withPermissions,
} from '../../src/harness/index.js';
import { ScriptedProvider, call, say } from '../helpers/scripted-provider.js';
import { toolNames as names, readTool } from '../helpers/tools.js';

const writeTool = (name: string): AgentTool =>
  defineTool({
    name,
    description: `The ${name} tool.`,
    kind: 'write',
    schema: z.object({}),
    execute: () => `${name} ran`,
  });

const request = (tool: string) =>
  ({ tool, toolCallId: 'c1', signal: new AbortController().signal }) as unknown as ApprovalRequest;

describe('capabilityFor', () => {
  test('a tool’s family, to the first _, else the first -, then .write', () => {
    expect(capabilityFor('calendar_create')).toBe('calendar.write');
    expect(capabilityFor('notion-create-pages')).toBe('notion.write');
    expect(capabilityFor('spend')).toBe('spend.write');
  });

  test('an MCP tool’s family is its whole server name', () => {
    expect(capabilityFor('google-calendar_create_event')).toBe('google-calendar.write');
    expect(capabilityFor('google-drive_upload')).toBe('google-drive.write');
  });
});

describe('resolvePermission', () => {
  test('with no rule, ask', () => {
    expect(resolvePermission({}, {}, 'calendar_create')).toBe('ask');
  });

  test('within one set the most specific key decides: tool, then capability, then *', () => {
    // The README's example.
    const mine = {
      'calendar.write': 'allow',
      'notion-create-pages': 'ask',
      '*': 'deny',
    } as const;
    expect(resolvePermission(mine, {}, 'calendar_create')).toBe('allow');
    expect(resolvePermission(mine, {}, 'notion-create-pages')).toBe('ask');
    expect(resolvePermission(mine, {}, 'email_send')).toBe('deny');
    expect(
      resolvePermission(
        { 'calendar.write': 'ask', calendar_create: 'allow' },
        {},
        'calendar_create'
      )
    ).toBe('allow');
  });

  test('a deny from either side is final', () => {
    expect(
      resolvePermission(
        { calendar_create: 'allow' },
        { 'calendar.write': 'deny' },
        'calendar_create'
      )
    ).toBe('deny');
    expect(
      resolvePermission(
        { 'calendar.write': 'deny' },
        { calendar_create: 'allow' },
        'calendar_create'
      )
    ).toBe('deny');
  });

  test('past a deny, the person’s rule decides, then the agent’s', () => {
    // An always-allow is not undone by the agent's ask.
    expect(resolvePermission({ x_y: 'allow' }, { x_y: 'ask' }, 'x_y')).toBe('allow');
    expect(resolvePermission({ x_y: 'ask' }, { x_y: 'allow' }, 'x_y')).toBe('ask');
    expect(resolvePermission({}, { 'x.write': 'allow' }, 'x_y')).toBe('allow');
  });
});

describe('withPermissions', () => {
  const asked: string[] = [];
  const ask = (r: ApprovalRequest) => {
    asked.push(r.tool);
    return { allow: true } as const;
  };
  const approve = withPermissions(
    (tool) => resolvePermission({ a_x: 'allow', d_x: 'deny' }, {}, tool),
    ask
  );

  test('allow and deny answer without asking; ask goes on', async () => {
    expect(await approve(request('a_x'))).toEqual({ allow: true });
    const denied = await approve(request('d_x'));
    expect(denied.allow).toBe(false);
    expect((denied as { tell: string }).tell).toContain('A standing rule denies d_x');
    expect(await approve(request('q_x'))).toEqual({ allow: true });
    expect(asked).toEqual(['q_x']);
  });
});

describe('a session with rules', () => {
  const run = async (mode: 'allow' | 'deny') => {
    const provider = new ScriptedProvider('p', [call('notes_save', {}), say('Done.')]);
    const agent = new Agent({
      routes: [{ client: provider, model: 'm' }],
      tools: [writeTool('notes_save')],
    });
    const session = new Session(agent, {
      approve: () => {
        throw new Error('nobody should be asked');
      },
      policy: (ask) => withPermissions(() => mode, ask),
    });
    await session.send('save it', { onEvent: () => {} });
    return provider.calls[1]?.find((m) => m.toolName === 'notes_save')?.content;
  };

  test('an allowed write runs without anyone being asked', async () => {
    expect(await run('allow')).toBe('notes_save ran');
  });

  test('a denied write never runs, and the model is told why', async () => {
    expect(await run('deny')).toContain('A standing rule denies notes_save');
  });
});

describe('approvals settings', () => {
  test('default to no rules, and refuse a mode that is not one', () => {
    expect(AppSettingsSchema.parse({}).approvals).toEqual({ rules: {} });
    expect(AppSettingsSchema.safeParse({ approvals: { rules: { x: 'maybe' } } }).success).toBe(
      false
    );
  });
});

describe('a read-only profile', () => {
  test('holds no write tool: base, own or group', () => {
    const inbox = defineToolGroup({
      name: 'inbox',
      summary: 'The person’s email.',
      briefing: 'Mail is listed newest first.',
      tools: [readTool('inbox_list'), writeTool('inbox_send')],
    });
    const outbox = defineToolGroup({
      name: 'outbox',
      summary: 'Sending mail.',
      briefing: 'Only send what the person approved.',
      tools: [writeTool('outbox_send')],
    });
    const tools = profileTools([readTool('read_webpage'), writeTool('notion_create')], {
      readOnly: true,
      tools: [writeTool('notes_save')],
      toolGroups: [inbox, outbox],
    });

    expect(names(tools)).toEqual(['read_webpage', OPEN_TOOL_GROUP]);
    const opener = tools.at(-1)!;
    // The group left with no tools is gone from the opener altogether.
    expect(names(opener.unlocks!.tools)).toEqual(['inbox_list']);
    expect(opener.definition.function.description).not.toContain('outbox');
  });

  test('reaches what any held tool can unlock, not only groups', () => {
    const send = writeTool('gmail_send');
    const draft = readTool('gmail_draft_view');
    const unlocker: AgentTool = {
      ...readTool('gmail_open'),
      unlocks: { tools: [draft, send], unlocked: () => [draft, send] },
    };
    const [held] = profileTools([], { readOnly: true, tools: [unlocker] });
    expect(names(held!.unlocks!.tools)).toEqual(['gmail_draft_view']);
    expect(names(held!.unlocks!.unlocked([]))).toEqual(['gmail_draft_view']);
  });

  test('a read-only profile with nothing left to open holds no opener', () => {
    const outbox = defineToolGroup({
      name: 'outbox',
      summary: 'Sending mail.',
      briefing: 'Only send what the person approved.',
      tools: [writeTool('outbox_send')],
    });
    expect(names(profileTools([], { readOnly: true, toolGroups: [outbox] }))).toEqual([]);
  });
});
