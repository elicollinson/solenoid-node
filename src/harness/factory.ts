/**
 * Harness Factory
 *
 * Builds what every agent shares from settings: the route chain (LM Studio
 * and OpenRouter clients), the injection screen (solenoid-security's Gemma
 * judge) and the base tool set (built-ins plus every connected MCP server).
 * Each session's agent is built from a profile (./profile.ts) on top of them.
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
  saveApprovalRule,
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
  stallGuardedFetch,
} from '../core/index.js';
import { McpManager } from '../mcp/index.js';
import { builtinTools } from '../tools/index.js';
import { agentLogger } from '../utils/logger.js';
import { type PermissionRules, resolvePermission, withPermissions } from './permissions.js';
import { type AgentProfile, profileTools } from './profile.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  SUBAGENT_GUIDE,
  SUBAGENT_ROLE,
  SUMMARIZER_PROMPT,
  withToday,
} from './prompt.js';
import { Session, declineUnattended } from './session.js';
import { SubagentManager } from './subagents.js';

/** LM Studio accepts any key when authentication is off; the SDK requires one. */
const LMSTUDIO_PLACEHOLDER_KEY = 'lm-studio';
/**
 * The longest timer a runtime allows: in effect none. Given to the SDK and to
 * the judge, whose own defaults are wall-clock deadlines (10 min, 120 s).
 */
const NO_TIMEOUT_MS = 2 ** 31 - 1;

/** The key to send, or undefined when the provider cannot be used without one. */
function providerKey(provider: ProviderName, settings: AppSettings): string | undefined {
  const key = getProviderApiKey(provider, settings);
  if (key) return key;
  return provider === 'lmstudio' ? LMSTUDIO_PLACEHOLDER_KEY : undefined;
}

/**
 * Every request to `provider`, the agent's and the judge's alike, fails only
 * when the server goes quiet for longer than its stall limits. Pair it with
 * NO_TIMEOUT_MS, so the guard is the only clock.
 */
function providerFetch(provider: ProviderName, settings: AppSettings): typeof fetch {
  const { first_byte_ms, idle_ms } = settings.providers[provider].stall;
  return stallGuardedFetch({ firstByteMs: first_byte_ms, idleMs: idle_ms });
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
        new OpenAI({
          baseURL: settings.providers[provider].base_url,
          apiKey,
          // The agent loop owns retries and fallback, and the stall guard owns time.
          maxRetries: 0,
          timeout: NO_TIMEOUT_MS,
          fetch: providerFetch(provider, settings),
        }),
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
    fetchFn: providerFetch(config.provider, settings),
    timeoutMs: NO_TIMEOUT_MS,
  });
  // The registry is the one defineTool and the system prompt register into,
  // so the screen subtracts this repository's own text before judging.
  return createSecurity({ provider: judge, authoredText }).screen;
}

export interface Harness {
  settings: AppSettings;
  /** The routes the agent tries, in order: `settings.routes` less any that were skipped. */
  routes: RouteRef[];
  /** Problems that did not stop startup: skipped routes, MCP servers that failed to connect. */
  warnings: string[];
  /**
   * A new conversation with an agent of `profile`; the default profile is
   * the CLI's agent. With `canSpawn`, the agent also holds the subagent
   * tools and can start child sessions, which never can themselves; each
   * child that finishes starts a turn with its result (Session.onAutoTurn).
   */
  createSession(profile?: AgentProfile): Session;
  /**
   * Allow `tool` from now on: live for every session at its next write, and
   * saved to `approvals.rules`. Undefined when saved; otherwise why the save
   * failed, and the rule holds only until the process ends.
   */
  allowAlways(tool: string): string | undefined;
  /**
   * Replace the person's standing rules with `rules`, live for every session
   * at its next write: for the settings screen, once it has saved them.
   */
  setApprovalRules(rules: PermissionRules): void;
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
      maxTurns: settings.agent.max_turns,
      screen,
      logger: agentLogger,
    });

  // One summarizer for every session's subagents: no tools, and the
  // transcript it reads is this process's own agents' work.
  const summarizer = makeAgent('solenoid/summarizer', [], SUMMARIZER_PROMPT);
  const summarize = async (task: string, transcript: string, signal: AbortSignal) => {
    const result = await summarizer.runMessages(
      [{ role: 'user', content: `Task:\n${task}\n\nTranscript:\n${transcript}`, origin: 'agent' }],
      { signal }
    );
    return result.output;
  };

  // Every open session, so closing the harness closes them and their subagents.
  const sessions = new Set<Session>();
  // The person's standing rules live in `settings.approvals.rules`, which
  // allowAlways and setApprovalRules replace, so `settings` stays true.
  const createSession: Harness['createSession'] = (profile = {}) => {
    const name = profile.name ?? 'solenoid';
    const agentTools = profileTools(tools, profile);
    const prompt = profile.systemPrompt ?? systemPrompt;
    // The rules answer first, before any asker, and are read at each write,
    // so a rule changed while the session runs applies to its next one.
    const policy = (ask: ApprovalHandler) =>
      withPermissions(
        // Read-only is enforced here too, where every write passes, not only
        // by keeping write tools out of sight.
        (tool) =>
          profile.readOnly
            ? 'deny'
            : resolvePermission(settings.approvals.rules, profile.permissions ?? {}, tool),
        ask
      );
    const manager = profile.canSpawn
      ? new SubagentManager({
          tools: agentTools,
          // A child follows the same rules; nobody can answer its asks, so they are declined.
          createSession: (childName, childTools) =>
            new Session(
              makeAgent(`${name}/${childName}`, childTools, `${prompt}\n\n${SUBAGENT_ROLE}`),
              { approve: declineUnattended, policy }
            ),
          summarize,
        })
      : undefined;
    const agent = manager
      ? makeAgent(name, [...agentTools, ...manager.tools()], `${prompt}\n\n${SUBAGENT_GUIDE}`)
      : makeAgent(name, agentTools, prompt);
    const session: Session = new Session(agent, {
      approve: profile.approve,
      policy,
      background: manager,
      onClose: () => {
        manager?.close();
        sessions.delete(session);
      },
    });
    sessions.add(session);
    return session;
  };
  const routeRefs = routes.map((r) => ({ provider: r.client.providerName, model: r.model }));
  agentLogger.info(
    {
      settingsPath: getSettingsPath(),
      routes: routeRefs,
      screening: settings.screening.enabled,
      baseTools: tools.map((t) => t.definition.function.name),
    },
    'Harness ready'
  );

  return {
    settings,
    routes: routeRefs,
    warnings: [
      ...skipped,
      ...mcpFailures.map((name) => `Could not connect to MCP server ${name}. See logs/server.log.`),
      // Its tools are `<server>_<tool>`, so its capability would end at the
      // server name's own `_` (see capabilityFor).
      ...Object.keys(settings.mcp_servers)
        .filter((name) => name.includes('_'))
        .map(
          (name) =>
            `MCP server ${name}: approval rules on ${name}.write will not match its tools; rename it with - instead of _.`
        ),
    ],
    createSession,
    allowAlways: (tool) => {
      settings.approvals.rules = { ...settings.approvals.rules, [tool]: 'allow' };
      const saved = saveApprovalRule(tool);
      return saved.isValid ? undefined : saved.errors.map((e) => e.message).join('; ');
    },
    setApprovalRules: (rules) => {
      settings.approvals.rules = rules;
    },
    close: async () => {
      for (const session of sessions) session.close();
      await mcp.close();
    },
  };
}
