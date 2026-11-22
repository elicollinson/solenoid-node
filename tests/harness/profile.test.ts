/**
 * Agent profiles: which tools a session's agent holds. No network: building a
 * harness connects nothing until a session runs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { authoredText } from '@elicollinson/solenoid-security';
import { z } from 'zod';
import { AppSettingsSchema } from '../../src/config/index.js';
import {
  type Harness,
  createHarness,
  defineProfile,
  profileTools,
} from '../../src/harness/index.js';
import { fakeModelServer } from '../helpers/fake-model-server.js';
import { call } from '../helpers/scripted-provider.js';
import { toolNames as names, readTool as tool, writeTool } from '../helpers/tools.js';

const base = [tool('read_webpage'), tool('render_chart')];

describe('profileTools', () => {
  test('the default profile holds the base tools', () => {
    expect(names(profileTools(base, {}))).toEqual(['read_webpage', 'render_chart']);
  });

  test('a profile drops the base tools it excludes and adds its own after the rest', () => {
    const tools = profileTools(base, {
      exclude: ['render_chart'],
      tools: [tool('calendar_list'), tool('calendar_create')],
    });
    expect(names(tools)).toEqual(['read_webpage', 'calendar_list', 'calendar_create']);
  });

  test('a profile can replace a base tool by excluding it and adding its own', () => {
    const own = tool('read_webpage');
    const tools = profileTools(base, { exclude: ['read_webpage'], tools: [own] });
    expect(tools).toContain(own);
    expect(names(tools)).toEqual(['render_chart', 'read_webpage']);
  });

  test('excluding a tool the base set lacks is an error, so a typo cannot widen an agent', () => {
    expect(() => profileTools(base, { exclude: ['web_serach'] })).toThrow(
      'Cannot exclude web_serach'
    );
  });
});

describe('defineProfile', () => {
  test('registers the prompt, so the screen subtracts it if the model quotes it', () => {
    const prompt = 'You triage the inbox and nothing else. Never send mail yourself.';
    expect(authoredText.redact(`quoted: ${prompt}`)).toContain(prompt);
    defineProfile({ name: 'triage', systemPrompt: prompt });
    expect(authoredText.redact(`quoted: ${prompt}`)).not.toContain(prompt);
  });
});

describe('Harness.createSession with a profile', () => {
  let harness: Harness | undefined;
  afterEach(() => harness?.close());

  const settings = AppSettingsSchema.parse({ screening: { enabled: false } });

  test('each session holds its own profile’s tools; the default is unchanged', async () => {
    harness = await createHarness(settings);
    const plain = harness.createSession();
    const triage = harness.createSession({
      name: 'triage',
      exclude: ['render_chart'],
      tools: [tool('inbox_list')],
      canSpawn: true,
    });

    // web_search joins the base set only where a search key is configured.
    const baseNames = plain.toolNames;
    expect(baseNames).toEqual(expect.arrayContaining(['read_webpage', 'render_chart']));
    expect(triage.toolNames.slice(0, baseNames.length)).toEqual([
      ...baseNames.filter((n) => n !== 'render_chart'),
      'inbox_list',
    ]);
    expect(triage.toolNames).toContain('spawn_subagent');
    // The profile's tools went to this session alone.
    expect(harness.createSession().toolNames).toEqual(baseNames);
  });

  test('a bad profile fails when the session is opened', async () => {
    harness = await createHarness(settings);
    expect(() => harness?.createSession({ exclude: ['nope'] })).toThrow('Cannot exclude nope');
    // Adding a tool the base set keeps: exclude the base one to replace it.
    expect(() => harness?.createSession({ tools: [tool('render_chart')] })).toThrow(
      'Agent tool "render_chart" is already registered'
    );
  });
});

describe('Harness.runStructured', () => {
  test('returns the validated object from an agent of the profile, declining writes nobody answers', async () => {
    // Tries the write first, then submits once it has been told no.
    const server = fakeModelServer((request) =>
      request.messages.at(-1)?.role === 'tool'
        ? call('submit_result', { sent: false })
        : call('mail_send', {})
    );
    const harness = await createHarness(
      AppSettingsSchema.parse({
        screening: { enabled: false },
        providers: { lmstudio: { base_url: server.baseUrl } },
        routes: [{ provider: 'lmstudio', model: 'scripted' }],
      })
    );
    try {
      const result = await harness.runStructured('Send it.', z.object({ sent: z.boolean() }), {
        profile: { tools: [writeTool('mail_send')] },
      });

      expect(result).toEqual({ sent: false });
      expect(server.requests[0]?.tools).toEqual(
        expect.arrayContaining(['mail_send', 'submit_result'])
      );
      const told = server.requests[1]?.messages.at(-1)?.content ?? '';
      expect(told).toContain('NOTHING WAS DONE');
      expect(told).not.toContain('mail_send ran');
    } finally {
      await harness.close();
      server.stop();
    }
  });
});
