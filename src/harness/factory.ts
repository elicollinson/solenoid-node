import type { AGUIEvent, Message } from '@ag-ui/core';
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
import type { z } from 'zod';
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
  type ChatMessage,
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
import { applyEvent } from './ag-ui/reducer.js';
import { type CheckpointStore, type SessionSummary, createCheckpointStore } from './checkpoints.js';
import { type PermissionRules, resolvePermission, withPermissions } from './permissions.js';
import { type AgentProfile, profilePermissions, profileTools } from './profile.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  SUBAGENT_GUIDE,
  SUBAGENT_ROLE,
  SUMMARIZER_PROMPT,
  withToday,
} from './prompt.js';
import { Session, type SessionCheckpointer, declineUnattended, encodeTurn } from './session.js';
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
  return stallGuardedFetch({ firstByteMs: first_byte_ms, idleMs: idle_ms, provider });
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

export interface ResumedSession {
  session: Session;
  summary: SessionSummary;
  /** True when the session's last checkpoint was written on a different device. */
  isRemote: boolean;
}

export interface ListedSession extends SessionSummary {
  /** True when the session's last checkpoint was written on a different device. */
  isRemote: boolean;
}

export interface CreateHarnessOptions {
  /** Override the checkpoint store, or pass null to disable persistence. */
  checkpointStore?: CheckpointStore | null;
}

export interface Harness {
  settings: AppSettings;
  /** The routes the agent tries, in order: `settings.routes` less any that were skipped. */
  routes: RouteRef[];
  /** Problems that did not stop startup: skipped routes, MCP servers that failed to connect. */
  warnings: string[];
  /** Durable checkpoint store when `settings.checkpoints.enabled` is true. */
  checkpoints?: CheckpointStore;
  /**
   * A new conversation with an agent of `profile`; the default profile is
   * the CLI's agent. With `canSpawn`, the agent also holds the subagent
   * tools and can start child sessions, which never can themselves; each
   * child that finishes starts a turn with its result (Session.onAutoTurn).
   */
  createSession(profile?: AgentProfile): Session;
  /**
   * One prompt in, one object matching `schema` out, from an agent of
   * `profile` (the default profile when omitted). No conversation is kept,
   * and `canSpawn` does not apply. The standing approval rules answer its
   * writes first; what they leave at ask goes to the profile's `approve`,
   * and with none it is declined, since nobody is there to ask. `onEvent`
   * gets the run as the AG-UI events of one turn, as a session's `send` does.
   */
  runStructured<S extends z.ZodType>(
    prompt: string,
    schema: S,
    options?: {
      profile?: AgentProfile;
      signal?: AbortSignal;
      onEvent?: (event: AGUIEvent) => void;
    }
  ): Promise<z.infer<S>>;
  /**
   * Resume a saved conversation by ID/prefix, or the most recent one when
   * omitted. Reports whether the session was last run on a remote device.
   */
  resumeSession(sessionIdOrPrefix?: string, profile?: AgentProfile): Promise<ResumedSession>;
  /** List saved top-level sessions, newest first, marking which ran on a remote device. */
  listSessions(limit?: number): Promise<ListedSession[]>;
  /**
   * Update this machine's device name in memory and backfill historical
   * session and checkpoint records for this device ID.
   */
  setDeviceName(name: string): Promise<number>;
  /**
   * Replace the person's standing rules (`settings.approvals.rules`), live
   * for every session at its next write. Saving them is the caller's: the
   * harness never writes a settings file.
   */
  setApprovalRules(rules: PermissionRules): void;
  close(): Promise<void>;
}

export async function createHarness(
  settings: AppSettings,
  options: CreateHarnessOptions = {}
): Promise<Harness> {
  const { routes, skipped } = createRoutes(settings);
  const screen = createScreener(settings);
  const mcp = new McpManager();
  const mcpFailures = await mcp.initialize(settings.mcp_servers);
  const tools = [
    ...builtinTools({ searchApiKey: getSearchApiKey(settings) }),
    ...mcp.getAgentTools(),
  ];
  const checkpoints =
    options.checkpointStore === null
      ? undefined
      : (options.checkpointStore ?? createCheckpointStore(settings));

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

  const checkpointerFor = (
    sessionId: string,
    parentId?: string
  ): SessionCheckpointer | undefined =>
    checkpoints
      ? {
          save: (cp) =>
            checkpoints.save({
              ...cp,
              sessionId,
              ...(parentId ? { parentId } : {}),
              device: settings.device,
            }),
          clear: () => checkpoints.delete(sessionId),
        }
      : undefined;

  // Every open session, so closing the harness closes them and their subagents.
  const sessions = new Set<Session>();
  // The person's standing rules live in `settings.approvals.rules`, which
  // setApprovalRules replaces, so `settings` stays true. The rules answer
  // first, before any asker, and are read at each write, so a rule changed
  // while a session runs applies to its next one.
  const policyFor = (profile: AgentProfile) => {
    const agentRules = profilePermissions(profile);
    return (ask: ApprovalHandler) =>
      withPermissions((tool) => resolvePermission(settings.approvals.rules, agentRules, tool), ask);
  };
  /** What a profile comes to on this harness: its agent's name, tools and prompt. */
  const resolve = (profile: AgentProfile) => ({
    name: profile.name ?? 'solenoid',
    agentTools: profileTools(tools, profile),
    prompt: profile.systemPrompt ?? systemPrompt,
  });
  const openSession = (
    profile: AgentProfile = {},
    restored?: {
      threadId: string;
      transcript: readonly ChatMessage[];
      thread: readonly Message[];
    }
  ): Session => {
    const threadId = restored?.threadId ?? crypto.randomUUID();
    const { name, agentTools, prompt } = resolve(profile);
    const policy = policyFor(profile);
    const manager = profile.canSpawn
      ? new SubagentManager({
          tools: agentTools,
          // A child follows the same rules; nobody can answer its asks, so they are declined.
          createSession: (childName, childTools) => {
            const childId = crypto.randomUUID();
            return new Session(
              makeAgent(`${name}/${childName}`, childTools, `${prompt}\n\n${SUBAGENT_ROLE}`),
              {
                threadId: childId,
                approve: declineUnattended,
                policy,
                checkpoint: checkpointerFor(childId, threadId),
              }
            );
          },
          summarize,
        })
      : undefined;
    const agent = manager
      ? makeAgent(name, [...agentTools, ...manager.tools()], `${prompt}\n\n${SUBAGENT_GUIDE}`)
      : makeAgent(name, agentTools, prompt);
    const session: Session = new Session(agent, {
      threadId,
      initialTranscript: restored?.transcript,
      initialThread: restored?.thread,
      checkpoint: checkpointerFor(threadId),
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

  const createSession: Harness['createSession'] = (profile = {}) => openSession(profile);

  const resumeSession: Harness['resumeSession'] = async (sessionIdOrPrefix, profile = {}) => {
    if (!checkpoints) {
      throw new Error('Checkpoints are disabled in settings (checkpoints.enabled: false).');
    }
    const key = sessionIdOrPrefix?.trim();
    const loaded = key ? await checkpoints.load(key) : await checkpoints.loadLatest();
    if (!loaded) {
      throw new Error(key ? `No saved session matching "${key}".` : 'No saved sessions to resume.');
    }
    const session = openSession(profile, {
      threadId: loaded.session.id,
      transcript: loaded.checkpoint.transcript,
      thread: loaded.checkpoint.thread,
    });
    return {
      session,
      summary: loaded.session,
      isRemote: loaded.session.lastDeviceId !== settings.device.id,
    };
  };

  const listSessions: Harness['listSessions'] = async (limit = 20) => {
    if (!checkpoints) return [];
    const list = await checkpoints.list(limit);
    return list.map((s) => ({
      ...s,
      isRemote: s.lastDeviceId !== settings.device.id,
    }));
  };

  let deviceRenameChain: Promise<void> = Promise.resolve();
  const setDeviceName: Harness['setDeviceName'] = (name) => {
    const trimmed = name.trim();
    if (!trimmed) return Promise.reject(new Error('Device name cannot be empty.'));
    const next = deviceRenameChain.then(async () => {
      const oldName = settings.device.name;
      settings.device.name = trimmed;
      if (!checkpoints) return 0;
      return checkpoints.renameDevice(settings.device.id, trimmed, oldName);
    });
    deviceRenameChain = next.then(
      () => {},
      () => {}
    );
    return next;
  };

  const runStructured: Harness['runStructured'] = (prompt, schema, options = {}) => {
    const { profile = {}, signal, onEvent } = options;
    const { name, agentTools, prompt: system } = resolve(profile);
    const agent = makeAgent(name, agentTools, system);
    // A turn with no session behind it: the thread is kept only for the
    // encoder's own snapshots.
    let thread: Message[] = [];
    const sink = {
      emit: (event: AGUIEvent) => {
        thread = applyEvent(thread, event);
        onEvent?.(event);
      },
      thread: () => thread,
    };
    return encodeTurn(
      crypto.randomUUID(),
      sink,
      { text: prompt, role: 'user' },
      async (encoder) => {
        const result = await agent.runMessages(
          [{ role: 'user', content: prompt, origin: 'operator' }],
          {
            signal,
            schema,
            onEvent: (event) => encoder.handle(event),
            approve: policyFor(profile)(profile.approve ?? declineUnattended),
          }
        );
        return result.output;
      }
    );
  };
  const routeRefs = routes.map((r) => ({ provider: r.client.providerName, model: r.model }));
  agentLogger.info(
    {
      settingsPath: getSettingsPath(),
      routes: routeRefs,
      screening: settings.screening.enabled,
      device: settings.device,
      checkpoints: Boolean(checkpoints),
      baseTools: tools.map((t) => t.definition.function.name),
    },
    'Harness ready'
  );

  return {
    settings,
    routes: routeRefs,
    checkpoints,
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
    runStructured,
    resumeSession,
    listSessions,
    setDeviceName,
    setApprovalRules: (rules) => {
      settings.approvals.rules = rules;
    },
    close: async () => {
      for (const session of sessions) session.close();
      await mcp.close();
      await checkpoints?.close();
    },
  };
}
