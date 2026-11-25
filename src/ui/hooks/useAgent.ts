/**
 * useAgent Hook
 *
 * Builds the harness once (connecting MCP servers) behind React Suspense and
 * hands the UI a conversation session for it.
 */
import { type Harness, type Session, createHarness } from '@elicollinson/solenoid-engine';
import { useState } from 'react';
import { getSettingsPath, loadSettings } from '../../config/index.js';
import { agentLogger } from '../../utils/logger.js';

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
    harnessResource = createResource(
      Promise.resolve().then(() => {
        const settings = loadSettings();
        return createHarness(settings, {
          logger: agentLogger,
          settingsPath: getSettingsPath() ?? undefined,
        });
      })
    );
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
  const [session] = useState(() => harness.createSession({ canSpawn: true }));
  return { harness, session };
}
