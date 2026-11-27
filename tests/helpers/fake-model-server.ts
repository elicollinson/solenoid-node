/**
 * An OpenAI-compatible chat server that answers from a script, for tests
 * that go through `createHarness` and so through the real provider client.
 * Loopback only.
 */
import type { ChatMessage } from '@elicollinson/solenoid-engine/core';

/** What the server was sent: the wire messages and the names of the tools offered. */
export interface FakeRequest {
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[] }>;
  tools: string[];
}

/** Answers one request, in the terms of ./scripted-provider.ts's `say` and `call`. */
export type Script = (request: FakeRequest) => ChatMessage;

export interface FakeModelServer {
  /** The provider `base_url` that reaches it. */
  baseUrl: string;
  requests: FakeRequest[];
  stop(): void;
}

export function fakeModelServer(script: Script): FakeModelServer {
  const requests: FakeRequest[] = [];
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as {
        messages: FakeRequest['messages'];
        tools?: Array<{ function: { name: string } }>;
      };
      const asked = {
        messages: body.messages,
        tools: (body.tools ?? []).map((tool) => tool.function.name),
      };
      requests.push(asked);
      const { content, toolCalls = [] } = script(asked);
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                ...(content ? { content } : {}),
                ...(toolCalls.length
                  ? {
                      // Ids are made here: a script reuses its own across turns.
                      tool_calls: toolCalls.map((call, index) => ({
                        index,
                        id: `call_${++calls}`,
                        type: 'function',
                        function: {
                          name: call.name,
                          arguments:
                            typeof call.arguments === 'string'
                              ? call.arguments
                              : JSON.stringify(call.arguments),
                        },
                      })),
                    }
                  : {}),
              },
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' },
          ],
        },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      );
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}

/** The text of the last message of `role` in a request. */
export const lastOf = (request: FakeRequest, role: string): string =>
  request.messages.findLast((message) => message.role === role)?.content ?? '';
