import { describe, expect, it } from 'bun:test';
import OpenAI from 'openai';
import {
  OpenAICompatibleProvider,
  ProviderStalledError,
  isTransientProviderError,
  stallGuardedFetch,
} from '../../src/core/index.js';

const encoder = new TextEncoder();
const limits = { firstByteMs: 40, idleMs: 40 };

/** A server that sends `chunks`, each after its delay, then holds the connection open if `hang`. */
function server(chunks: Array<[delayMs: number, text: string]>, hang = false): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      async start(stream) {
        init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason));
        for (const [delay, text] of chunks) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (init?.signal?.aborted) return;
          stream.enqueue(encoder.encode(text));
        }
        if (!hang) stream.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

/** A server that never answers at all. */
const silent = ((_input: unknown, init?: RequestInit) =>
  new Promise((_, reject) =>
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  )) as typeof fetch;

const sse = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
const done = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

describe('stallGuardedFetch', () => {
  it('lets a slow stream finish as long as it keeps sending', async () => {
    // 6 chunks, each 25ms apart: 150ms in all, well past either limit.
    const chunks = Array.from({ length: 6 }, (_, i): [number, string] => [25, `${i}`]);
    const response = await stallGuardedFetch(limits, server(chunks))('http://x');
    expect(await response.text()).toBe('012345');
  });

  it('fails a response that never starts', async () => {
    const error = await stallGuardedFetch(limits, silent)('http://x').catch((e) => e);
    expect(error).toBeInstanceOf(ProviderStalledError);
    expect(error.phase).toBe('first_byte');
  });

  it('fails a stream that goes quiet part-way', async () => {
    const response = await stallGuardedFetch(limits, server([[0, 'a']], true))('http://x');
    const error = await response.text().catch((e) => e);
    expect(error).toBeInstanceOf(ProviderStalledError);
    expect(error.phase).toBe('idle');
  });

  it('reports the caller’s abort, not a stall', async () => {
    const controller = new AbortController();
    const pending = stallGuardedFetch({ firstByteMs: 1_000, idleMs: 1_000 }, silent)('http://x', {
      signal: controller.signal,
    });
    controller.abort();
    const error = await pending.catch((e) => e);
    expect(error).not.toBeInstanceOf(ProviderStalledError);
  });
});

describe('a provider behind the guard', () => {
  const provider = (inner: typeof fetch) =>
    new OpenAICompatibleProvider(
      new OpenAI({
        baseURL: 'http://x/v1',
        apiKey: 'k',
        maxRetries: 0,
        fetch: stallGuardedFetch(limits, inner),
      }),
      'lmstudio'
    );
  const chat = (inner: typeof fetch) =>
    provider(inner).chat([{ role: 'user', content: 'hi' }], { model: 'm', tools: [] });

  it('streams a slow but steady answer', async () => {
    const chunks = ['a', 'b', 'c', 'd'].map((c): [number, string] => [25, sse(c)]);
    const message = await chat(server([...chunks, [0, done]]));
    expect(message.content).toBe('abcd');
  });

  for (const [name, inner] of [
    ['before the response', silent],
    ['mid-stream', server([[0, sse('a')]], true)],
  ] as const) {
    it(`surfaces a stall ${name}, and does not retry it`, async () => {
      const error = await chat(inner).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderStalledError);
      expect(isTransientProviderError(error)).toBe(false);
    });
  }
});
