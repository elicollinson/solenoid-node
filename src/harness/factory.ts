/**
 * Harness Factory
 *
 * Builds the one agent from settings: the route chain (LM Studio and
 * OpenRouter clients), the injection screen (solenoid-security's Gemma
 * judge), and the tool set (built-ins plus every connected MCP server).
 */
import {
  OpenAICompatibleJudge,
  authoredText,
  createSecurity,
} from '@elicollinson/solenoid-security';
import OpenAI from 'openai';
import {
  type AppSettings,
  type ProviderName,
  getProviderApiKey,
  getSettingsPath,
} from '../config/index.js';
import {
  Agent,
  type ModelRoute,
  type ModelRouteChain,
  OpenAICompatibleProvider,
  type Screener,
} from '../core/index.js';
import { McpManager } from '../mcp/index.js';
import { builtinTools } from '../tools/index.js';
import { agentLogger } from '../utils/logger.js';
import { DEFAULT_SYSTEM_PROMPT } from './prompt.js';

/** LM Studio accepts any key when authentication is off; the SDK requires one. */
const LMSTUDIO_PLACEHOLDER_KEY = 'lm-studio';

/** The key to send, or undefined when the provider cannot be used without one. */
function providerKey(provider: ProviderName, settings: AppSettings): string | undefined {
  const key = getProviderApiKey(provider, settings);
  if (key) return key;
  return provider === 'lmstudio' ? LMSTUDIO_PLACEHOLDER_KEY : undefined;
}

const MISSING_KEY_HINT = 'export OPENROUTER_API_KEY or set providers.openrouter.api_key';

export interface RouteChain {
  routes: ModelRouteChain;
  /** Routes left out because their provider has no credentials. */
  skipped: string[];
}

/**
 * Build the route chain. A route whose provider has no credentials is left
 * out rather than failing startup, so the default chain (LM Studio, then
 * OpenRouter) works on a machine without an OpenRouter key. It fails only
 * when no route is left.
 */
export function createRoutes(settings: AppSettings): RouteChain {
  const clients = new Map<ProviderName, OpenAICompatibleProvider>();
  const clientFor = (provider: ProviderName) => {
    let client = clients.get(provider);
    if (!client) {
      client = new OpenAICompatibleProvider(
        new OpenAI({
          baseURL: settings.providers[provider].base_url,
          apiKey: providerKey(provider, settings)!,
          // The agent loop owns retries and fallback.
          maxRetries: 0,
        }),
        { name: provider, dialect: provider }
      );
      clients.set(provider, client);
    }
    return client;
  };
  const routes: ModelRoute[] = [];
  const skipped: string[] = [];
  for (const route of settings.routes) {
    if (providerKey(route.provider, settings) === undefined) {
      skipped.push(`${route.provider}: ${route.model}`);
      continue;
    }
    routes.push({ client: clientFor(route.provider), model: route.model });
  }
  if (!routes.length) {
    throw new Error(`No usable model route: every route needs credentials (${MISSING_KEY_HINT}).`);
  }
  return { routes: routes as unknown as ModelRouteChain, skipped };
}

/** The screen, or undefined when `screening.enabled` is false. */
export function createScreener(settings: AppSettings): Screener | undefined {
  const config = settings.screening;
  if (!config.enabled) return undefined;
  const apiKey = providerKey(config.provider, settings);
  if (apiKey === undefined) {
    // Never silently unscreened: a configured screen that cannot run is a
    // startup error, not a quiet downgrade.
    throw new Error(
      `Screening is configured on ${config.provider}, which has no API key (${MISSING_KEY_HINT}).`
    );
  }
  const judge = new OpenAICompatibleJudge({
    baseUrl: settings.providers[config.provider].base_url,
    model: config.model,
    apiKey,
    threshold: config.threshold,
    timeoutMs: config.timeout_ms,
  });
  // The registry is the one defineTool and the system prompt register into,
  // so the screen subtracts this repository's own text before judging.
  return createSecurity({ provider: judge, authoredText }).screen;
}

export interface Harness {
  agent: Agent;
  settings: AppSettings;
  /** Names of the tools the agent holds, built-ins first. */
  toolNames: string[];
  /** Problems that did not stop startup: skipped routes, MCP servers that failed to connect. */
  warnings: string[];
  close(): Promise<void>;
}

export async function createHarness(settings: AppSettings): Promise<Harness> {
  const { routes, skipped } = createRoutes(settings);
  const screen = createScreener(settings);
  const mcp = new McpManager();
  const mcpFailures = await mcp.initialize(settings.mcp_servers);
  const searchKey = process.env.BRAVE_SEARCH_API_KEY ?? settings.search.brave_search_api_key;
  const tools = [
    ...builtinTools({ search: settings.search.provider === 'brave' && Boolean(searchKey) }),
    ...mcp.getAgentTools(),
  ];

  const agent = new Agent({
    name: 'solenoid',
    routes,
    systemPrompt: settings.agent.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
    tools,
    think: settings.agent.think,
    timeoutMs: settings.agent.timeout_ms,
    screen,
    logger: agentLogger,
  });
  agentLogger.info(
    {
      settingsPath: getSettingsPath(),
      routes: settings.routes,
      screening: settings.screening.enabled,
      tools: agent.toolDefinitions.map((t) => t.function.name),
    },
    'Harness ready'
  );

  return {
    agent,
    settings,
    toolNames: agent.toolDefinitions.map((t) => t.function.name),
    warnings: [
      ...skipped.map((route) => `Skipped route ${route}: no API key (${MISSING_KEY_HINT}).`),
      ...mcpFailures.map((name) => `Could not connect to MCP server ${name}. See logs/server.log.`),
    ],
    close: () => mcp.close(),
  };
}
