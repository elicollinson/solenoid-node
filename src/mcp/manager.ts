/**
 * MCP Manager
 *
 * Manages connections to Model Context Protocol (MCP) servers. Handles
 * server discovery from configuration, connection establishment (stdio or HTTP),
 * tool discovery, and tool invocation. Supports multiple concurrent server
 * connections with namespaced tool names, exposed to the agent as AgentTools.
 *
 * Dependencies:
 * - @modelcontextprotocol/sdk: Official MCP client SDK for server communication
 *   - StdioClientTransport: Connects to MCP servers via subprocess stdio
 *   - StreamableHTTPClientTransport: Connects to MCP servers via HTTP
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { McpServer, McpStdioServer } from '../config/schema.js';
import type { AgentTool, ToolKind } from '../core/index.js';
import { serverLogger } from '../utils/logger.js';

interface McpTool {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
}

export class McpManager {
  private clients: Map<string, Client> = new Map();
  private tools: Map<string, McpTool> = new Map();
  private initialized = false;

  /** Connect to every configured server. Returns the names that failed. */
  async initialize(servers: Record<string, McpServer>): Promise<string[]> {
    if (this.initialized) return [];

    const failures: string[] = [];
    for (const [name, config] of Object.entries(servers)) {
      try {
        await this.connectServer(name, config);
      } catch (error) {
        failures.push(name);
        serverLogger.warn({ error: String(error) }, `MCP: Failed to connect to ${name}`);
      }
    }

    this.initialized = true;
    return failures;
  }

  private async connectServer(name: string, config: McpServer): Promise<void> {
    const client = new Client({
      name: `solenoid-${name}`,
      version: '2.0.0',
    });

    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (this.isStdioServer(config)) {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers,
        },
      });
    }

    await client.connect(transport);
    this.clients.set(name, client);

    // Discover tools
    const toolsList = await client.listTools();
    for (const tool of toolsList.tools) {
      const fullName = `${name}_${tool.name}`;
      this.tools.set(fullName, {
        serverName: name,
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
        // A server only tells us whether a call changes anything through the
        // readOnlyHint annotation. Without it, nothing here can work it out,
        // so the tool is a write and asks before it runs.
        kind: tool.annotations?.readOnlyHint === true ? 'read' : 'write',
      });
    }

    serverLogger.info(`MCP: Connected to ${name} with ${toolsList.tools.length} tools`);
  }

  private isStdioServer(config: McpServer): config is McpStdioServer {
    return 'command' in config;
  }

  /**
   * Every discovered tool as an AgentTool. Built by hand rather than through
   * defineTool: a remote server's description is that server's text, not
   * ours, and must never be registered as authored text the injection screen
   * would subtract. The argument schema is permissive because the server
   * validates its own arguments.
   */
  getAgentTools(): AgentTool[] {
    return [...this.tools].map(([fullName, tool]) => ({
      kind: tool.kind,
      schema: z.record(z.string(), z.unknown()),
      definition: {
        type: 'function' as const,
        function: {
          name: fullName,
          description: `[MCP:${tool.serverName}] ${tool.description}`,
          parameters: { type: 'object', properties: {}, ...tool.inputSchema },
        },
      },
      execute: async (args: unknown) => {
        const result = await this.callTool(fullName, args as Record<string, unknown>);
        if (!result.ok) throw new Error(result.output);
        return result.output;
      },
    }));
  }

  async callTool(
    fullName: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; output: string }> {
    const tool = this.tools.get(fullName);
    if (!tool) {
      return { ok: false, output: `Unknown MCP tool: ${fullName}` };
    }

    const client = this.clients.get(tool.serverName);
    if (!client) {
      return { ok: false, output: `MCP server not connected: ${tool.serverName}` };
    }

    try {
      const result = await client.callTool({
        name: tool.name,
        arguments: args,
      });

      // Extract text content from result
      const content = result.content as Array<{ type: string; text?: string }>;
      const textContent = content
        .filter(
          (c): c is { type: 'text'; text: string } =>
            c.type === 'text' && typeof c.text === 'string'
        )
        .map((c) => c.text)
        .join('\n');

      const output = textContent || JSON.stringify(result.content);
      return { ok: result.isError !== true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, output: `Error calling MCP tool ${fullName}: ${message}` };
    }
  }

  async close(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch (error) {
        serverLogger.warn({ error }, `MCP: Error closing ${name}`);
      }
    }
    this.clients.clear();
    this.tools.clear();
    this.initialized = false;
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

let defaultManager: McpManager | null = null;

export function getMcpManager(): McpManager {
  if (!defaultManager) {
    defaultManager = new McpManager();
  }
  return defaultManager;
}

export async function closeMcpManager(): Promise<void> {
  if (defaultManager) {
    await defaultManager.close();
    defaultManager = null;
  }
}
