/**
 * Signals
 *
 * Waiting under an AbortSignal. One answer to "what does an aborted signal
 * throw": its reason when that is an Error (a timeout, say), otherwise
 * AgentAbortedError. Shared by the loop and the provider so callers can
 * dispatch on one error type.
 */
import { AgentAbortedError } from './errors.js';

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new AgentAbortedError();
}

/** Settle with `promise`, or reject with the abort reason as soon as `signal` fires. */
export function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The abort wins, but the abandoned promise may still reject; observe it
    // so it does not surface as an unhandled rejection.
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** Resolve after `ms`, or reject with the abort reason if `signal` fires first. */
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
