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
  PROVIDER_KEY_ENV,
  type ProviderName,
  getProviderApiKey,
  getSearchApiKey,
  getSettingsPath,
} from '../config/index.js';
import {
  Agent,
  type AgentTool,
  type ApprovalHandler,
  type ModelRoute,
  type ModelRouteChain,
  OpenAICompatibleProvider,
  type RouteRef,
  type Screener,
} from '../core/index.js';
import { McpManager } from '../mcp/index.js';
import { builtinTools } from '../tools/index.js';
import { agentLogger } from '../utils/logger.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  SUBAGENT_GUIDE,
  SUBAGENT_ROLE,
  SUMMARIZER_PROMPT,
  withToday,
} from './prompt.js';
import { Session } from './session.js';
import { SubagentManager, subagentToolNames } from './subagents.js';

/** LM Studio accepts any key when authentication is off; the SDK requires one. */
const LMSTUDIO_PLACEHOLDER_KEY = 'lm-studio';

/** The key to send, or undefined when the provider cannot be used without one. */
function providerKey(provider: ProviderName, settings: AppSettings): string | undefined {
  const key = getProviderApiKey(provider, settings);
  if (key) return key;
  return provider === 'lmstudio' ? LMSTUDIO_PLACEHOLDER_KEY : undefined;
}

function missingKeyHint(provider: ProviderName): string {
  return `export ${PROVIDER_KEY_ENV[provider]} or set providers.${provider}.api_key`;
}

interface RouteChain {
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
function createRoutes(settings: AppSettings): RouteChain {
  const clients = new Map<ProviderName, OpenAICompatibleProvider>();
  const routes: ModelRoute[] = [];
  const skipped: string[] = [];
  for (const { provider, model } of settings.routes) {
    const apiKey = providerKey(provider, settings);
    if (apiKey === undefined) {
      skipped.push(
        `Skipped route ${provider}: ${model}: no API key (${missingKeyHint(provider)}).`
      );
      continue;
    }
    let client = clients.get(provider);
    if (!client) {
      client = new OpenAICompatibleProvider(
        // The agent loop owns retries and fallback.
        new OpenAI({ baseURL: settings.providers[provider].base_url, apiKey, maxRetries: 0 }),
        provider
      );
      clients.set(provider, client);
    }
    routes.push({ client, model });
  }
  const [first, ...rest] = routes;
  if (!first) {
    throw new Error(
      `No usable model route: every route needs credentials (${[
        ...new Set(settings.routes.map((r) => missingKeyHint(r.provider))),
      ].join('; ')}).`
    );
  }
  return { routes: [first, ...rest], skipped };
}

/** The screen, or undefined when `screening.enabled` is false. */
function createScreener(settings: AppSettings): Screener | undefined {
  const config = settings.screening;
  if (!config.enabled) return undefined;
  const apiKey = providerKey(config.provider, settings);
  if (apiKey === undefined) {
    // Never silently unscreened: a configured screen that cannot run is a
    // startup error, not a quiet downgrade.
    throw new Error(
      `Screening is configured on ${config.provider}, which has no API key (${missingKeyHint(config.provider)}).`
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
  settings: AppSettings;
  /** The routes the agent tries, in order: `settings.routes` less any that were skipped. */
  routes: RouteRef[];
  /** Names of the tools a session that can spawn holds, built-ins first. */
  toolNames: string[];
  /** Problems that did not stop startup: skipped routes, MCP servers that failed to connect. */
  warnings: string[];
  /**
   * A new conversation. With `canSpawn`, its agent also holds the subagent
   * tools and can start child sessions, which never can themselves; each
   * child that finishes starts a turn with its result (Session.onAutoTurn).
   * `approve` replaces the approval interrupts (see SessionOptions).
   */
  createSession(options?: { canSpawn?: boolean; approve?: ApprovalHandler }): Session;
  close(): Promise<void>;
}

export async function createHarness(settings: AppSettings): Promise<Harness> {
  const { routes, skipped } = createRoutes(settings);
  const screen = createScreener(settings);
  const mcp = new McpManager();
  const mcpFailures = await mcp.initialize(settings.mcp_servers);
  const tools = [
    ...builtinTools({ searchApiKey: getSearchApiKey(settings) }),
    ...mcp.getAgentTools(),
  ];

  const systemPrompt = settings.agent.system_prompt ?? DEFAULT_SYSTEM_PROMPT;
  const makeAgent = (name: string, agentTools: AgentTool[], prompt: string) =>
    new Agent({
      name,
      routes,
      systemPrompt: withToday(prompt),
      tools: agentTools,
      think: settings.agent.think,
      timeoutMs: settings.agent.timeout_ms,
      maxTurns: settings.agent.max_turns,
      screen,
      logger: agentLogger,
    });

  // One summarizer for every session's subagents: no tools, and the
  // transcript it reads is this process's own agents' work.
  const summarizer = makeAgent('solenoid/summarizer', [], SUMMARIZER_PROMPT);
  const summarize = async (task: string, transcript: string) => {
    const result = await summarizer.runMessages([
      {
        role: 'user',
        content: `Task:\n${task}\n\nTranscript:\n${transcript}`,
        origin: 'agent',
      },
    ]);
    return result.output;
  };

  // Every open session, so closing the harness closes them and their subagents.
  const sessions = new Set<Session>();
  const track = (session: Session) => {
    sessions.add(session);
    return session;
  };
  const plainAgent = makeAgent('solenoid', tools, systemPrompt);

  const createSession: Harness['createSession'] = ({ canSpawn = false, approve } = {}) => {
    if (!canSpawn) return track(new Session(plainAgent, { approve }));
    const manager = new SubagentManager({
      tools,
      createSession: (name, childTools, options) =>
        new Session(
          makeAgent(`solenoid/${name}`, childTools, `${systemPrompt}\n\n${SUBAGENT_ROLE}`),
          options
        ),
      summarize,
    });
    const agent = makeAgent(
      'solenoid',
      [...tools, ...manager.tools()],
      `${systemPrompt}\n\n${SUBAGENT_GUIDE}`
    );
    const session: Session = new Session(agent, {
      approve,
      background: manager,
      onClose: () => {
        manager.close();
        sessions.delete(session);
      },
    });
    return track(session);
  };
  const toolNames = [...tools.map((t) => t.definition.function.name), ...subagentToolNames()];
  const routeRefs = routes.map((r) => ({ provider: r.client.providerName, model: r.model }));
  agentLogger.info(
    {
      settingsPath: getSettingsPath(),
      routes: routeRefs,
      screening: settings.screening.enabled,
      tools: toolNames,
    },
    'Harness ready'
  );

  return {
    settings,
    routes: routeRefs,
    toolNames,
    warnings: [
      ...skipped,
      ...mcpFailures.map((name) => `Could not connect to MCP server ${name}. See logs/server.log.`),
    ],
    createSession,
    close: async () => {
      for (const session of sessions) session.close();
      await mcp.close();
    },
  };
}
