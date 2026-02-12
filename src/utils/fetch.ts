/**
 * Fetch with Timeout
 *
 * Wraps the standard fetch API with an AbortSignal-based timeout.
 * Throws an error if the request exceeds the specified duration.
 */

const DEFAULT_FETCH_TIMEOUT_MS = 30_000; // 30 seconds

export async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
