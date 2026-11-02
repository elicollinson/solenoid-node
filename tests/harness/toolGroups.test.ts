/**
 * Tool groups: closed until the model opens one, then callable from its next
 * turn, for as long as the transcript holds the call that opened it.
 */
import { describe, expect, test } from 'bun:test';
import { Agent, type AgentTool, type ChatMessage } from '../../src/core/index.js';
import {
  OPEN_TOOL_GROUP,
  defineToolGroup,
  profileTools,
  toolGroupOpener,
} from '../../src/harness/index.js';
import { ScriptedProvider, type Step, call, say } from '../helpers/scripted-provider.js';
import { toolNames as names, readTool as tool, toolContext } from '../helpers/tools.js';

const calendar = defineToolGroup({
  name: 'calendar',
  summary: 'The person’s calendar: events, holds and who is invited.',
  briefing: 'Events are listed by day. Never cancel an event the person did not name.',
  tools: [tool('calendar_list'), tool('calendar_read')],
});
const reminders = defineToolGroup({
  name: 'reminders',
  summary: 'Reminders the person asked for, and when each is due.',
  briefing: 'A reminder fires once at its time. Completing one is final.',
  tools: [tool('reminders_list')],
});

/** The transcript after a completed open of `group`. */
const opened = (group: string, id = 'c1'): ChatMessage[] => [
  { role: 'user', content: 'hi' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: OPEN_TOOL_GROUP, arguments: { group } }],
  },
  { role: 'tool', toolCallId: id, toolName: OPEN_TOOL_GROUP, content: 'briefing' },
];

/** An agent holding `tools`, answering from `steps`. */
function agentWith(tools: AgentTool[], steps: Step[]) {
  const provider = new ScriptedProvider('p', steps);
  return { provider, agent: new Agent({ routes: [{ client: provider, model: 'm' }], tools }) };
}

const ask = (agent: Agent) =>
  agent.runMessages([{ role: 'user', content: 'What is on my calendar?' }]);

describe('defineToolGroup', () => {
  test('a group needs a snake_case name and at least one tool', () => {
    expect(() => defineToolGroup({ ...calendar, name: 'Calendar' })).toThrow('snake_case');
    expect(() => defineToolGroup({ ...calendar, tools: [] })).toThrow('has no tools');
  });
});

describe('toolGroupOpener', () => {
  const opener = toolGroupOpener([calendar, reminders])!;
  const unlocked = (messages: ChatMessage[]) => names(opener.unlocks!.unlocked(messages));

  test('one opener lists every group by its summary, and can unlock all their tools', () => {
    const { description } = opener.definition.function;
    expect(description).toContain(`calendar: ${calendar.summary}`);
    expect(description).toContain(`reminders: ${reminders.summary}`);
    expect(names(opener.unlocks!.tools)).toEqual([
      'calendar_list',
      'calendar_read',
      'reminders_list',
    ]);
  });

  test('opening answers with the briefing and the tools it unlocks', async () => {
    const answer = await opener.execute({ group: 'calendar' }, toolContext());
    expect(answer).toContain(calendar.briefing);
    expect(answer).toContain('- calendar_list: The calendar_list tool.');
  });

  test('every group starts closed; a completed open unlocks that group alone', () => {
    expect(unlocked([{ role: 'user', content: 'hi' }])).toEqual([]);
    expect(unlocked(opened('calendar'))).toEqual(['calendar_list', 'calendar_read']);
  });

  test('a call with no answer yet, or naming no group, opens nothing', () => {
    expect(unlocked(opened('calendar').slice(0, 2))).toEqual([]);
    expect(unlocked(opened('weather'))).toEqual([]);
  });

  test('no groups, no opener; two groups of one name are refused', () => {
    expect(toolGroupOpener([])).toBeUndefined();
    expect(() => toolGroupOpener([calendar, calendar])).toThrow('share a name');
  });
});

describe('an agent holding the opener', () => {
  const groups = { toolGroups: [calendar, reminders] };

  test('holds the opener, and lists the group tools among those it can call', () => {
    const tools = profileTools([tool('read_webpage')], groups);
    expect(names(tools)).toEqual(['read_webpage', OPEN_TOOL_GROUP]);
    const { agent } = agentWith(tools, []);
    expect(agent.toolDefinitions.map((d) => d.function.name)).toEqual([
      'read_webpage',
      OPEN_TOOL_GROUP,
      'calendar_list',
      'calendar_read',
      'reminders_list',
    ]);
  });

  test('a group tool whose name is taken fails when the agent is built, not mid-run', () => {
    expect(() => agentWith(profileTools([tool('calendar_list')], groups), [])).toThrow(
      'Agent tool "calendar_list" is already registered'
    );
  });

  test('the model opens a group, then calls its tool on the next turn', async () => {
    const { agent, provider } = agentWith(profileTools([], groups), [
      call(OPEN_TOOL_GROUP, { group: 'calendar' }),
      call('calendar_list', {}),
      say('You have two events.'),
    ]);

    const result = await ask(agent);

    expect(result.output).toBe('You have two events.');
    expect(provider.offered[0]).toEqual([OPEN_TOOL_GROUP]);
    expect(provider.offered[1]).toEqual([OPEN_TOOL_GROUP, 'calendar_list', 'calendar_read']);
    expect(result.messages.find((m) => m.toolName === 'calendar_list')?.content).toBe(
      'calendar_list ran'
    );
  });

  test('a group tool called before its group is opened is unknown', async () => {
    const { agent } = agentWith(profileTools([], groups), [
      call('calendar_list', {}),
      say('Could not.'),
    ]);

    const result = await ask(agent);

    expect(result.messages.find((m) => m.toolName === 'calendar_list')?.content).toContain(
      'unknown tool "calendar_list"'
    );
  });
});

describe('groups that share tools', () => {
  // One tool object, in two task-shaped groups.
  const lookupContact = tool('lookup_contact');
  const scheduling = defineToolGroup({
    name: 'scheduling',
    summary: 'Arranging meetings: finding times and inviting people.',
    briefing: 'Find a free time before you invite anyone.',
    tools: [tool('find_time'), lookupContact],
  });
  const messaging = defineToolGroup({
    name: 'messaging',
    summary: 'Reading and drafting messages to people.',
    briefing: 'Draft; never send without the person saying so.',
    tools: [tool('draft_message'), lookupContact],
  });
  const groups = { toolGroups: [scheduling, messaging] };
  const callable = (agent: Agent) => agent.toolDefinitions.map((d) => d.function.name);

  test('the same tool in two groups is registered once', () => {
    const { agent } = agentWith(profileTools([], groups), []);
    expect(callable(agent)).toEqual([
      OPEN_TOOL_GROUP,
      'find_time',
      'lookup_contact',
      'draft_message',
    ]);
  });

  test('the same tool held and in a group is registered once, as held', () => {
    const { agent } = agentWith(profileTools([lookupContact], groups), []);
    expect(callable(agent)).toEqual([
      'lookup_contact',
      OPEN_TOOL_GROUP,
      'find_time',
      'draft_message',
    ]);
  });

  test('a different tool under a name already registered is still refused', () => {
    const clash = defineToolGroup({ ...messaging, name: 'clash', tools: [tool('lookup_contact')] });
    expect(() => agentWith(profileTools([], { toolGroups: [scheduling, clash] }), [])).toThrow(
      'Agent tool "lookup_contact" is already registered'
    );
  });

  test('opening both offers the shared tool once; the second briefing only names it', async () => {
    const { agent, provider } = agentWith(profileTools([], groups), [
      call(OPEN_TOOL_GROUP, { group: 'scheduling' }, 'o1'),
      call(OPEN_TOOL_GROUP, { group: 'messaging' }, 'o2'),
      say('Ready.'),
    ]);

    const { messages } = await ask(agent);

    expect(provider.offered[2]).toEqual([
      OPEN_TOOL_GROUP,
      'find_time',
      'lookup_contact',
      'draft_message',
    ]);
    const second = messages.find((m) => m.toolCallId === 'o2')?.content ?? '';
    expect(second).toContain(messaging.briefing);
    expect(second).toContain('- draft_message: The draft_message tool.');
    expect(second).not.toContain('- lookup_contact');
    expect(second).toContain('Already available: lookup_contact.');
  });

  test('opening a group again answers in one line, without the briefing', async () => {
    const { agent } = agentWith(profileTools([], groups), [
      call(OPEN_TOOL_GROUP, { group: 'scheduling' }, 'o1'),
      call(OPEN_TOOL_GROUP, { group: 'scheduling' }, 'o2'),
      say('Ready.'),
    ]);

    const { messages } = await ask(agent);

    expect(messages.find((m) => m.toolCallId === 'o2')?.content).toBe(
      'The scheduling group is already open. Its tools: find_time, lookup_contact.'
    );
  });
});
