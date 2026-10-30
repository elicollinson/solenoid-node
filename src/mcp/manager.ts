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
import type { McpServer } from '../config/schema.js';
import type { AgentTool } from '../core/index.js';
import { serverLogger } from '../utils/logger.js';

export class McpManager {
  private clients: Array<{ name: string; client: Client }> = [];
  private tools: AgentTool[] = [];

  /** Connect to every configured server, concurrently. Returns the names that failed. */
  async initialize(servers: Record<string, McpServer>): Promise<string[]> {
    const entries = Object.entries(servers);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connectServer(name, config))
    );
    const failures: string[] = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') return;
      const name = entries[i]![0];
      failures.push(name);
      serverLogger.warn({ error: String(result.reason) }, `MCP: Failed to connect to ${name}`);
    });
    return failures;
  }

  private async connectServer(name: string, config: McpServer): Promise<void> {
    const client = new Client({
      name: `solenoid-${name}`,
      version: '2.0.0',
    });

    const transport =
      config.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers },
          })
        : new StdioClientTransport({ command: config.command, args: config.args, env: config.env });

    await client.connect(transport);
    this.clients.push({ name, client });

    const { tools } = await client.listTools();
    for (const tool of tools) {
      this.tools.push(mcpTool(client, name, tool));
    }

    serverLogger.info(`MCP: Connected to ${name} with ${tools.length} tools`);
  }

  /** Every discovered tool, in server order. */
  getAgentTools(): AgentTool[] {
    return [...this.tools];
  }

  async close(): Promise<void> {
    await Promise.all(
      this.clients.map(async ({ name, client }) => {
        try {
          await client.close();
        } catch (error) {
          serverLogger.warn({ error }, `MCP: Error closing ${name}`);
        }
      })
    );
    this.clients = [];
    this.tools = [];
  }
}

type ListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

/**
 * One remote tool as an AgentTool. Built by hand rather than through
 * defineTool: a remote server's description is that server's text, not ours,
 * and must never be registered as authored text the injection screen would
 * subtract. The argument schema is permissive because the server validates
 * its own arguments.
 */
function mcpTool(client: Client, serverName: string, tool: ListedTool): AgentTool {
  const fullName = `${serverName}_${tool.name}`;
  return {
    // A server only tells us whether a call changes anything through the
    // readOnlyHint annotation. Without it, nothing here can work it out, so
    // the tool is a write and asks before it runs.
    kind: tool.annotations?.readOnlyHint === true ? 'read' : 'write',
    schema: z.record(z.string(), z.unknown()),
    definition: {
      type: 'function',
      function: {
        name: fullName,
        description: `[MCP:${serverName}] ${tool.description ?? ''}`,
        parameters: { properties: {}, ...tool.inputSchema },
      },
    },
    execute: async (args) => {
      const result = await client.callTool({
        name: tool.name,
        arguments: args as Record<string, unknown>,
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      const output =
        content
          .filter(
            (c): c is { type: 'text'; text: string } =>
              c.type === 'text' && typeof c.text === 'string'
          )
          .map((c) => c.text)
          .join('\n') || JSON.stringify(result.content);
      if (result.isError === true) throw new Error(output);
      return output;
    },
  };
}
