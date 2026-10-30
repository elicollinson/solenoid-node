/**
 * Tools Module
 *
 * The agent's built-in tools. MCP tools are added at startup from
 * ../mcp/manager.ts.
 */
import type { AgentTool } from '../core/index.js';
import { embedArtifactTool, listArtifactsTool, saveArtifactTool } from './artifacts.js';
import { renderChartTool } from './chart.js';
import { createWebSearchTool, readWebpageTool } from './web.js';

export * from './artifacts.js';
export * from './brave-search.js';
export * from './chart.js';
export * from './web-reader.js';
export * from './web.js';

export interface BuiltinToolOptions {
  /** Web search needs a Brave API key; without one the tool is left out. */
  searchApiKey?: string;
}

export function builtinTools(options: BuiltinToolOptions): AgentTool[] {
  return [
    ...(options.searchApiKey ? [createWebSearchTool(options.searchApiKey)] : []),
    readWebpageTool,
    renderChartTool,
    saveArtifactTool,
    listArtifactsTool,
    embedArtifactTool,
  ] as AgentTool[];
}
