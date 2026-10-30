/**
 * Artifact Store
 *
 * Module-level singleton that holds rich outputs (charts, tables, text) the
 * agent produces during a turn, so the UI can render the original content
 * inline instead of the model reconstructing it as ASCII.
 *
 * Same singleton pattern as cachedSettings in settings.ts.
 */

export interface Artifact {
  id: string;
  type: 'chart' | 'table' | 'text';
  title?: string;
  /** Raw data: chart tool args, {headers, rows} for table, {content} for text */
  data: unknown;
  timestamp: number;
}

const artifacts: Map<string, Artifact> = new Map();
let nextId = 1;

/**
 * Save an artifact to the store.
 * Returns the generated artifact ID.
 */
export function saveArtifact(artifact: Omit<Artifact, 'id' | 'timestamp'>): string {
  const id = `artifact_${nextId++}`;
  artifacts.set(id, {
    ...artifact,
    id,
    timestamp: Date.now(),
  });
  return id;
}

/**
 * Retrieve an artifact by ID.
 */
export function getArtifact(id: string): Artifact | undefined {
  return artifacts.get(id);
}

/**
 * List all artifacts in the store.
 */
export function listArtifacts(): Artifact[] {
  return Array.from(artifacts.values());
}

/**
 * Clear all artifacts. Called at the start of each turn.
 */
export function clearArtifacts(): void {
  artifacts.clear();
  nextId = 1;
}
