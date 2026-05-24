/**
 * Artifact Tools (ADK)
 *
 * FunctionTool instances for the artifact system:
 * - save_artifact: Agents save tables/text artifacts explicitly
 * - list_artifacts: Response formatting agent discovers available artifacts
 * - embed_artifact: Response formatting agent places artifact inline in output
 *
 * Follows the FunctionTool pattern from adk-tools.ts.
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod/v3';
import { getArtifact, listArtifacts, saveArtifact } from './store.js';

/**
 * Tool for agents to save structured output as an artifact.
 * Used by code_executor_agent, generic_executor_agent, etc.
 */
export const saveArtifactTool = new FunctionTool({
  name: 'save_artifact',
  description: `Save structured output (table or text) as an artifact for rich rendering in the final response.
Use this when you produce data tables or formatted text that should be preserved exactly as-is.
- For tables: provide type "table" with headers and rows
- For text: provide type "text" with content`,
  parameters: z.object({
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
  // biome-ignore lint/suspicious/noExplicitAny: ADK FunctionTool types params as unknown due to zod version mismatch
  execute: async (args: any) => {
    const { type, title, headers, rows, content, format } = args as {
      type: 'table' | 'text';
      title?: string;
      headers?: string[];
      rows?: string[][];
      content?: string;
      format?: 'markdown' | 'plain';
    };

    const data =
      type === 'table'
        ? { headers: headers ?? [], rows: rows ?? [] }
        : { content: content ?? '', format: format ?? 'markdown' };

    const artifactId = saveArtifact({
      type,
      title,
      data,
      agentName: 'unknown',
    });

    return { status: 'success', artifactId };
  },
});

/**
 * Tool for the response formatting agent to discover available artifacts.
 */
export const listArtifactsTool = new FunctionTool({
  name: 'list_artifacts',
  description:
    'List all artifacts created during the current turn. Use this to discover charts, tables, and text artifacts available for embedding.',
  parameters: z.object({}),
  execute: async () => {
    const items = listArtifacts();
    return {
      artifacts: items.map((a) => ({
        id: a.id,
        type: a.type,
        title: a.title,
        agentName: a.agentName,
      })),
    };
  },
});

/**
 * Tool for the response formatting agent to embed an artifact inline.
 * The UI recognizes this tool call (like render_chart) and renders the
 * stored content from the artifact store.
 */
export const embedArtifactTool = new FunctionTool({
  name: 'embed_artifact',
  description:
    'Embed a previously created artifact inline in the response. The UI will render it as a rich element (chart, table, or formatted text). Call this for each artifact you want to include in the final output.',
  parameters: z.object({
    artifactId: z.string().describe('The ID of the artifact to embed'),
  }),
  // biome-ignore lint/suspicious/noExplicitAny: ADK FunctionTool types params as unknown due to zod version mismatch
  execute: async (args: any) => {
    const { artifactId } = args as { artifactId: string };
    const artifact = getArtifact(artifactId);
    if (!artifact) {
      return { status: 'error', error: `Artifact ${artifactId} not found` };
    }
    return {
      status: 'success',
      artifactType: artifact.type,
      title: artifact.title,
      artifactId: artifact.id,
    };
  },
});
