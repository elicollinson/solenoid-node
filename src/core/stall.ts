/**
 * Stall Guard
 *
 * A fetch for a provider's client that gives up on a request only when the
 * server stops sending, never because the work is slow. A model that is
 * still streaming tokens is left to finish however long that takes; a
 * request that goes silent is aborted with ProviderStalledError, and the
 * agent moves to the next route.
 *
 * Two limits, because a request is quiet for two different reasons:
 * - `firstByteMs`: until the first byte of the body. This covers the queue
 *   and prompt processing, which on a local model grow with the context.
 * - `idleMs`: between chunks once the body is flowing.
 */
import { ProviderStalledError } from './errors.js';
import { abortReason } from './signals.js';

export interface StallLimits {
  firstByteMs: number;
  idleMs: number;
}

export function stallGuardedFetch(limits: StallLimits, inner: typeof fetch = fetch): typeof fetch {
  const guarded = async (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
    const caller = init?.signal;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (phase: ProviderStalledError['phase']) => {
      clearTimeout(timer);
      const ms = phase === 'idle' ? limits.idleMs : limits.firstByteMs;
      timer = setTimeout(() => controller.abort(new ProviderStalledError(phase, ms)), ms);
    };
    const disarm = () => clearTimeout(timer);
    // Whatever the inner fetch throws once the guard fired, the stall is the cause.
    const failure = (error: unknown) =>
      controller.signal.aborted && !caller?.aborted ? abortReason(controller.signal) : error;

    arm('first_byte');
    let response: Response;
    try {
      response = await inner(input, {
        ...init,
        signal: caller ? AbortSignal.any([caller, controller.signal]) : controller.signal,
      });
    } catch (error) {
      disarm();
      throw failure(error);
    }
    if (!response.body) {
      disarm();
      return response;
    }

    const reader = response.body.getReader();
    let phase: ProviderStalledError['phase'] = 'first_byte';
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            disarm();
            stream.close();
            return;
          }
          if (value.byteLength) {
            if (phase === 'idle') timer?.refresh();
            else arm((phase = 'idle'));
          }
          stream.enqueue(value);
        } catch (error) {
          disarm();
          stream.error(failure(error));
        }
      },
      cancel(reason) {
        disarm();
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return guarded as typeof fetch;
}
