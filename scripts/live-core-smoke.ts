/**
 * Live smoke test for the core loop against real backends.
 *
 * Runs a two-turn tool-using conversation on each configured route, with the
 * Gemma judge screening every boundary. Needs LM Studio on LMSTUDIO_BASE_URL
 * (default http://localhost:1234/v1) and, for the OpenRouter route,
 * OPENROUTER_API_KEY.
 *
 *   bun run scripts/live-core-smoke.ts
 */
import {
  OpenAICompatibleJudge,
  authoredText,
  createSecurity,
} from '@elicollinson/solenoid-security';
import OpenAI from 'openai';
import { z } from 'zod/v4';
import {
  Agent,
  type ChatMessage,
  OpenAICompatibleProvider,
  defineTool,
} from '../src/core/index.js';

const lmstudioUrl = process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';
const lmstudioKey = process.env.LMSTUDIO_API_KEY ?? 'lm-studio';

const security = createSecurity({
  provider: new OpenAICompatibleJudge({
    baseUrl: lmstudioUrl,
    model: 'google/gemma-4-26b-a4b',
    apiKey: lmstudioKey,
  }),
  authoredText,
});

const weather = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  kind: 'read',
  schema: z.object({ city: z.string().describe('City name') }),
  execute: ({ city }) => `${city}: 18°C, light rain, wind 12 km/h.`,
});

const routes = [
  {
    label: 'lmstudio',
    client: new OpenAICompatibleProvider(
      new OpenAI({ baseURL: lmstudioUrl, apiKey: lmstudioKey }),
      { name: 'lmstudio', dialect: 'lmstudio' }
    ),
    model: 'google/gemma-4-26b-a4b',
  },
  ...(process.env.OPENROUTER_API_KEY
    ? [
        {
          label: 'openrouter',
          client: new OpenAICompatibleProvider(
            new OpenAI({
              baseURL: 'https://openrouter.ai/api/v1',
              apiKey: process.env.OPENROUTER_API_KEY,
            }),
            { name: 'openrouter', dialect: 'openrouter' }
          ),
          model: 'google/gemma-4-26b-a4b-it',
        },
      ]
    : []),
];

for (const route of routes) {
  const agent = new Agent({
    name: `smoke-${route.label}`,
    routes: [{ client: route.client, model: route.model }],
    systemPrompt: 'You are a concise assistant. Use tools when they help.',
    tools: [weather],
    think: 'low',
    screen: security.screen,
  });
  const started = performance.now();
  const counts: Record<string, number> = {};
  const onEvent = (e: { type: string }) => {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  };

  let history: ChatMessage[] = [
    { role: 'user', content: 'What is the weather in Paris right now?', origin: 'operator' },
  ];
  const first = await agent.runMessages(history, { onEvent });
  history = [
    ...first.messages,
    { role: 'user', content: 'And should I bring an umbrella? One sentence.', origin: 'operator' },
  ];
  const second = await agent.runMessages(history, { onEvent });

  console.log(`\n== ${route.label} (${((performance.now() - started) / 1000).toFixed(1)}s)`);
  console.log('turn 1:', first.output);
  console.log('turn 2:', second.output);
  console.log('events:', counts);
}
