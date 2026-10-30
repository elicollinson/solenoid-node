/**
 * OpenAI-compatible provider tests, against a fake client that replays
 * chunk shapes captured from LM Studio and OpenRouter.
 */
import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { type ChatDelta, OpenAICompatibleProvider } from '../../src/core/providers.js';

function fakeClient(chunks: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          requests.push(body);
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  } as unknown as OpenAI;
  return { client, requests };
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
});

describe('OpenAICompatibleProvider', () => {
  test('LM Studio: streams reasoning_content and assembles tool-call fragments', async () => {
    const { client, requests } = fakeClient([
      chunk({ role: 'assistant', reasoning_content: 'The user' }),
      chunk({ reasoning_content: ' wants weather' }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
      chunk({}, 'tool_calls'),
      {
        choices: [],
        usage: {
          prompt_tokens: 66,
          completion_tokens: 133,
          total_tokens: 199,
          completion_tokens_details: { reasoning_tokens: 114 },
        },
      },
    ]);
    const provider = new OpenAICompatibleProvider(client, {
      name: 'lmstudio',
      dialect: 'lmstudio',
    });
    const deltas: ChatDelta[] = [];

    const msg = await provider.chat([{ role: 'user', content: 'weather?' }], {
      model: 'google/gemma-4-26b-a4b',
      tools: [],
      think: 'low',
      onDelta: (d) => deltas.push(d),
    });

    expect(requests[0]).toMatchObject({ stream: true, reasoning_effort: 'low' });
    expect(msg.thinking).toBe('The user wants weather');
    expect(msg.toolCalls).toEqual([
      { id: 'abc', name: 'get_weather', arguments: { city: 'Paris' } },
    ]);
    expect(msg.finishReason).toBe('tool_calls');
    expect(msg.usage).toEqual({
      promptTokens: 66,
      completionTokens: 133,
      totalTokens: 199,
      reasoningTokens: 114,
    });
    expect(deltas.map((d) => d.type)).toEqual(['reasoning', 'reasoning']);
    expect(msg.raw).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'abc', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    });
  });

  test('OpenRouter: reads `reasoning`, merges reasoning_details and sends a reasoning object', async () => {
    const { client, requests } = fakeClient([
      chunk({
        role: 'assistant',
        content: '',
        reasoning: 'Think',
        reasoning_details: [{ type: 'reasoning.text', text: 'Think', index: 0 }],
      }),
      chunk({
        reasoning: 'ing',
        reasoning_details: [{ type: 'reasoning.text', text: 'ing', index: 0 }],
      }),
      chunk({ content: 'Hi' }, 'stop'),
    ]);
    const provider = new OpenAICompatibleProvider(client, {
      name: 'openrouter',
      dialect: 'openrouter',
    });

    const msg = await provider.chat([{ role: 'user', content: 'hello' }], {
      model: 'google/gemma-4-26b-a4b-it',
      tools: [],
      think: 'high',
    });

    expect(requests[0]).toMatchObject({ reasoning: { effort: 'high' } });
    expect(requests[0]).not.toHaveProperty('reasoning_effort');
    expect(msg.thinking).toBe('Thinking');
    expect(msg.content).toBe('Hi');
    expect(msg.raw).toMatchObject({
      reasoning_details: [{ type: 'reasoning.text', text: 'Thinking', index: 0 }],
    });
  });

  test('echoes the native assistant payload and maps tool results on later turns', async () => {
    const { client, requests } = fakeClient([chunk({ content: 'ok' }, 'stop')]);
    const provider = new OpenAICompatibleProvider(client, {
      name: 'lmstudio',
      dialect: 'lmstudio',
    });
    const raw = { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] };

    await provider.chat(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', raw },
        { role: 'tool', content: 'result', toolCallId: 't1', toolName: 'x' },
      ],
      { model: 'm', tools: [] }
    );

    expect(requests[0]!.messages).toEqual([
      { role: 'user', content: 'q' },
      raw,
      { role: 'tool', tool_call_id: 't1', content: 'result' },
    ]);
  });

  test('think: false disables reasoning in each dialect', async () => {
    const lm = fakeClient([chunk({ content: 'a' }, 'stop')]);
    const or = fakeClient([chunk({ content: 'a' }, 'stop')]);
    await new OpenAICompatibleProvider(lm.client, { name: 'l', dialect: 'lmstudio' }).chat([], {
      model: 'm',
      tools: [],
      think: false,
    });
    await new OpenAICompatibleProvider(or.client, { name: 'o', dialect: 'openrouter' }).chat([], {
      model: 'm',
      tools: [],
      think: false,
    });

    expect(lm.requests[0]).toMatchObject({ reasoning_effort: 'none' });
    expect(or.requests[0]).toMatchObject({ reasoning: { enabled: false } });
  });
});
