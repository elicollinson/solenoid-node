/**
 * useAgent Hook
 *
 * Builds the harness once (connecting MCP servers) behind React Suspense and
 * hands the UI a conversation session for it.
 */
import { useRef } from 'react';
import { loadSettings } from '../../config/index.js';
import { type Harness, Session, createHarness } from '../../harness/index.js';

/**
 * Resource wrapper for Suspense compatibility.
 * Throws the promise while pending, returns result when resolved.
 */
function createResource<T>(promise: Promise<T>) {
  let status: 'pending' | 'success' | 'error' = 'pending';
  let result: T;
  let error: Error;

  const suspender = promise.then(
    (r) => {
      status = 'success';
      result = r;
    },
    (e) => {
      status = 'error';
      error = e instanceof Error ? e : new Error(String(e));
    }
  );

  return {
    read(): T {
      if (status === 'pending') throw suspender;
      if (status === 'error') throw error;
      return result;
    },
  };
}

// Singleton resource created at module level
let harnessResource: ReturnType<typeof createResource<Harness>> | null = null;

function getHarnessResource() {
  if (!harnessResource) {
    harnessResource = createResource(Promise.resolve().then(() => createHarness(loadSettings())));
  }
  return harnessResource;
}

/** The harness from the most recent successful startup, for shutdown. */
export function currentHarness(): Harness | undefined {
  try {
    return harnessResource?.read();
  } catch {
    return undefined;
  }
}

export function useAgent(): { harness: Harness; session: Session } {
  // Suspends until the harness is ready
  const harness = getHarnessResource().read();
  const sessionRef = useRef<Session | null>(null);
  if (!sessionRef.current) sessionRef.current = new Session(harness.agent);
  return { harness, session: sessionRef.current };
}
