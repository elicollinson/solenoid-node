/**
 * Artifact Tools
 *
 * - save_artifact: keep a table or text block for exact, rich rendering
 * - list_artifacts: see what this turn has produced
 * - embed_artifact: place an artifact inline in the reply; the UI recognizes
 *   this call (like render_chart) and renders the stored content
 *
 * Internal tools: they touch only this turn's in-memory display store, which
 * is cleared before the next turn, and return only what the model passed in
 * (titles, cells, ids) plus this file's literals.
 */
import { z } from 'zod';
import { getArtifact, listArtifacts, saveArtifact } from '../artifacts/index.js';
import { defineTool } from '../core/index.js';

export const saveArtifactTool = defineTool({
  name: 'save_artifact',
  description: `Save structured output (table or text) as an artifact for rich rendering in your reply.
Use this when you produce data tables or formatted text that should be preserved exactly as-is, then call embed_artifact where it belongs.
- For tables: provide type "table" with headers and rows
- For text: provide type "text" with content`,
  kind: 'internal',
  schema: z.object({
    type: z.enum(['table', 'text']).describe('The artifact type'),
    title: z.string().optional().describe('Display title for the artifact'),
    headers: z.array(z.string()).optional().describe('Column headers (for table type)'),
    rows: z
      .array(z.array(z.string()))
      .optional()
      .describe('Table rows as arrays of strings (for table type)'),
    content: z.string().optional().describe('Text content (for text type)'),
    format: z.enum(['markdown', 'plain']).optional().describe('Text format (for text type)'),
  }),
  execute: ({ type, title, headers, rows, content, format }) => {
    const data =
      type === 'table'
        ? { headers: headers ?? [], rows: rows ?? [] }
        : { content: content ?? '', format: format ?? 'markdown' };
    const artifactId = saveArtifact({ type, title, data });
    return { status: 'success', artifactId };
  },
});

export const listArtifactsTool = defineTool({
  name: 'list_artifacts',
  description:
    'List all artifacts created during the current turn: tables and text available for embedding.',
  kind: 'internal',
  schema: z.object({}),
  execute: () => ({
    artifacts: listArtifacts().map((a) => ({ id: a.id, type: a.type, title: a.title })),
  }),
});

export const embedArtifactTool = defineTool({
  name: 'embed_artifact',
  description:
    'Embed a previously created artifact inline in your reply. The UI renders it as a rich element (table or formatted text) at this point in the response.',
  kind: 'internal',
  schema: z.object({
    artifactId: z.string().describe('The ID of the artifact to embed'),
  }),
  execute: ({ artifactId }) => {
    const artifact = getArtifact(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} not found`);
    return {
      status: 'success',
      artifactType: artifact.type,
      title: artifact.title,
      artifactId: artifact.id,
    };
  },
});
