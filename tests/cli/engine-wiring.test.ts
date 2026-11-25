/**
 * Thin-CLI Migration Parity & Engine Wiring Tests (Wave 1 — Surface 4)
 *
 * Validates the target architecture for `Solenoid-node` once engine internals
 * move into `@elicollinson/solenoid-engine` and permission/approval policy
 * lives in `@elicollinson/solenoid-security`:
 *
 * 1. No duplicate engine code left behind under `Solenoid-node/src/`, and all
 *    thin-CLI / Ink UI entrypoints import engine & security primitives from
 *    `@elicollinson/solenoid-engine` and `@elicollinson/solenoid-security`.
 * 2. YAML settings (`AppSettingsSchema`, `loadSettings`, `saveApprovalRule`,
 *    `saveDeviceName`) bridge cleanly to `@elicollinson/solenoid-security`
 *    (`capabilityFor`, `resolvePermission`, `withPermissions`, `PermissionStore`,
 *    `ApprovalBroker`) and `@elicollinson/solenoid-engine` (`createHarness`,
 *    `setApprovalRules`), including the `y` / `n` / `a` persistence flow.
 * 3. Headless CLI & Session parity (100% offline with `ScriptedProvider` +
 *    `:memory:` `SqliteCheckpointStore`): multi-turn sessions, `--continue`,
 *    `--resume <prefix>`, `/sessions`, `/device-name`, `--yes` vs unattended
 *    `declineUnattended`, `onAutoTurn` background subagents, and Phase 2
 *    mid-turn interrupt checkpoint persistence across restarts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { type AGUIEvent, EventType } from '@ag-ui/core';
import {
  APPROVAL_REASON,
  type AgentTool,
  type AutoTurn,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
  type CheckpointStore,
  type PendingCheckpointState,
  SqliteCheckpointStore,
  applyEvent,
  approvalAnswer,
  createHarness,
  defineTool,
  findToolCall,
  parseToolArgs,
} from '@elicollinson/solenoid-engine';
import {
  AlreadySettledError,
  ApprovalBroker,
  ApprovalDigestMismatchError,
  type ApprovalRecord,
  InMemoryApprovalStore,
  type PermissionRules,
  type PermissionStore,
  type ToolRequest,
  capabilityFor,
  computeArgsDigest,
  declineUnattended,
  resolvePermission,
  withPermissions,
} from '@elicollinson/solenoid-security';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  type AppSettings,
  AppSettingsSchema,
  clearSettingsCache,
  loadSettings,
  saveApprovalRule,
  saveDeviceName,
} from '../../src/config/index.js';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const SRC_DIR = join(REPO_ROOT, 'src');

const DELETED_ENGINE_DIRS = ['core', 'harness', 'mcp', 'tools', 'display'] as const;

// ---------------------------------------------------------------------------
// Offline test helpers (zero network calls, zero TCP binds)
// ---------------------------------------------------------------------------

type ScriptStep =
  | ChatMessage
  | Error
  | ((messages: ChatMessage[], opts: ChatOptions) => ChatMessage | Promise<ChatMessage>);

class ScriptedProvider implements ChatProvider {
  readonly calls: ChatMessage[][] = [];
  readonly offered: string[][] = [];

  constructor(
    readonly providerName: string,
    private readonly steps: ScriptStep[]
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    this.calls.push(messages.map((m) => ({ ...m })));
    this.offered.push(opts.tools.map((t) => t.function.name));
    const step = this.steps.shift();
    if (!step) throw new Error(`${this.providerName}: script exhausted`);
    if (step instanceof Error) throw step;
    const msg = typeof step === 'function' ? await step(messages, opts) : step;
    if (msg.content) opts.onDelta?.({ type: 'text', text: msg.content });
    return msg;
  }
}

/** Routes parent vs subagent calls deterministically without sharing a flat step queue. */
class RoutedScriptedProvider implements ChatProvider {
  readonly parentCalls: ChatMessage[][] = [];
  readonly childCalls: ChatMessage[][] = [];

  constructor(
    readonly providerName: string,
    private readonly parentSteps: ScriptStep[],
    private readonly childSteps: ScriptStep[]
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const isParent = opts.tools.some((t) => t.function.name === 'spawn_subagent');
    const log = isParent ? this.parentCalls : this.childCalls;
    const queue = isParent ? this.parentSteps : this.childSteps;
    log.push(messages.map((m) => ({ ...m })));
    const step = queue.shift();
    if (!step) {
      throw new Error(`${this.providerName}: ${isParent ? 'parent' : 'child'} script exhausted`);
    }
    if (step instanceof Error) throw step;
    const msg = typeof step === 'function' ? await step(messages, opts) : step;
    if (msg.content) opts.onDelta?.({ type: 'text', text: msg.content });
    return msg;
  }
}

const say = (content: string): ChatMessage => ({ role: 'assistant', content });

const call = (name: string, args: unknown, id = `call_${name}`): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, arguments: args }],
});

/**
 * Wraps a `:memory:` `SqliteCheckpointStore` so closing harness #1 tears down
 * its sessions cleanly without destroying the shared in-memory DB before
 * harness #2 resumes from it. When `isCrashed()` becomes true, further writes
 * from the "crashed" process are dropped (simulating SIGKILL).
 */
function sharedStoreView(
  store: CheckpointStore,
  isCrashed: () => boolean = () => false
): CheckpointStore {
  return {
    save: async (input) => {
      if (isCrashed()) return { seq: 0, turnStartSeq: 0 };
      return store.save(input);
    },
    load: (key) => store.load(key),
    loadLatest: () => store.loadLatest(),
    list: (limit) => store.list(limit),
    renameDevice: (deviceId, newName, oldName) => store.renameDevice(deviceId, newName, oldName),
    ...(store.reconcileOrphaned ? { reconcileOrphaned: () => store.reconcileOrphaned!() } : {}),
    delete: async (sessionId) => {
      if (isCrashed()) return;
      return store.delete(sessionId);
    },
    close: async () => {},
  };
}

function collectSourceFiles(dir: string, skipTopDirs: ReadonlySet<string>): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const walk = (current: string, isRoot: boolean) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (isRoot && entry.isDirectory() && skipTopDirs.has(entry.name)) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, false);
      } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
        results.push(fullPath);
      }
    }
  };
  walk(dir, true);
  return results;
}

function writeTempSettingsYaml(dir: string, raw: Record<string, unknown>): string {
  const yamlPath = join(dir, 'app_settings.yaml');
  writeFileSync(yamlPath, stringifyYaml(raw, { indent: 2, lineWidth: 0 }), 'utf-8');
  return yamlPath;
}

function makeCalendarTools(log: { created: string[]; updated: string[] }): {
  calendarCreate: AgentTool;
  calendarUpdate: AgentTool;
} {
  const calendarCreate = defineTool({
    name: 'calendar_create',
    description: 'Create a calendar event.',
    kind: 'write',
    schema: z.object({ title: z.string() }),
    execute: ({ title }) => {
      log.created.push(title);
      return `created:${title}`;
    },
  });

  const calendarUpdate = defineTool({
    name: 'calendar_update',
    description: 'Update an existing calendar event.',
    kind: 'write',
    schema: z.object({ id: z.string() }),
    execute: ({ id }) => {
      log.updated.push(id);
      return `updated:${id}`;
    },
  });

  return { calendarCreate, calendarUpdate };
}

function makeNotesWriteTool(log: string[]): AgentTool {
  return defineTool({
    name: 'notes_create',
    description: 'Create a note.',
    kind: 'write',
    schema: z.object({ text: z.string() }),
    execute: ({ text }) => {
      log.push(text);
      return `note:${text}`;
    },
  });
}

function makeEchoReadTool(log?: string[]): AgentTool {
  return defineTool({
    name: 'echo_read',
    description: 'Read an echoed value.',
    kind: 'read',
    schema: z.object({ text: z.string() }),
    execute: ({ text }) => {
      log?.push(text);
      return `echo:${text}`;
    },
  });
}

// ---------------------------------------------------------------------------
// 1. No duplicate engine code left behind
// ---------------------------------------------------------------------------

describe('1. Thin-CLI boundary & zero duplicate engine code', () => {
  test('deleted engine directories do not exist under Solenoid-node/src/', () => {
    const remaining = DELETED_ENGINE_DIRS.filter((dir) => existsSync(join(SRC_DIR, dir)));
    expect(remaining).toEqual([]);
  });

  test('no remaining source file in Solenoid-node/src/ imports from deleted local engine directories', () => {
    const files = collectSourceFiles(SRC_DIR, new Set(DELETED_ENGINE_DIRS));
    const localEngineImport =
      /(?:import|export)\b[\s\S]*?\bfrom\s+['"](?:\.\.?\/)+(?:core|harness|mcp|tools|display)(?:\/|['"])/;

    const offending: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      if (localEngineImport.test(source)) {
        offending.push(relative(REPO_ROOT, file));
      }
    }
    expect(offending).toEqual([]);
  });

  test('src/index.ts re-exports engine primitives from @elicollinson/solenoid-engine', () => {
    const indexPath = join(SRC_DIR, 'index.ts');
    const source = readFileSync(indexPath, 'utf-8');

    expect(source).toMatch(/from\s+['"]@elicollinson\/solenoid-engine(?:\/[^'"]+)?['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\/(?:core|harness|mcp|tools|display)(?:\/|['"])/);
  });

  test('CLI entrypoint and Ink UI import engine primitives from @elicollinson/solenoid-engine and security primitives from @elicollinson/solenoid-security', () => {
    const cliEntryPaths = [
      join(SRC_DIR, 'cli.ts'),
      ...(existsSync(join(SRC_DIR, 'cli-runner.ts')) ? [join(SRC_DIR, 'cli-runner.ts')] : []),
    ];
    const cliSource = cliEntryPaths.map((p) => readFileSync(p, 'utf-8')).join('\n');

    expect(cliSource).toMatch(/from\s+['"]@elicollinson\/solenoid-engine(?:\/[^'"]+)?['"]/);
    expect(cliSource).not.toMatch(/from\s+['"]\.\/(?:core|harness|mcp|tools|display)(?:\/|['"])/);

    const uiFiles = [
      join(SRC_DIR, 'ui', 'app.tsx'),
      join(SRC_DIR, 'ui', 'hooks', 'useAgent.ts'),
      join(SRC_DIR, 'ui', 'components', 'catalog.tsx'),
    ];
    for (const file of uiFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content).toMatch(/from\s+['"]@elicollinson\/solenoid-engine(?:\/[^'"]+)?['"]/);
    }

    const securityConsumerPaths = [
      join(SRC_DIR, 'index.ts'),
      ...cliEntryPaths,
      join(SRC_DIR, 'ui', 'app.tsx'),
      join(SRC_DIR, 'config', 'settingsManager.ts'),
    ].filter((p) => existsSync(p));
    const combinedThinSrc = securityConsumerPaths.map((p) => readFileSync(p, 'utf-8')).join('\n');

    expect(combinedThinSrc).toMatch(/from\s+['"]@elicollinson\/solenoid-security['"]/);
  });

  test('package.json declares @elicollinson/solenoid-engine and @elicollinson/solenoid-security dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@elicollinson/solenoid-engine']).toBeTruthy();
    expect(pkg.dependencies?.['@elicollinson/solenoid-security']).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. YAML settings & approval rules bridge to solenoid-security + solenoid-engine
// ---------------------------------------------------------------------------

describe('2. YAML settings & approval rules bridge to solenoid-security + solenoid-engine', () => {
  let tmpDir = '';

  beforeEach(() => {
    clearSettingsCache();
    tmpDir = mkdtempSync(join(tmpdir(), 'solenoid-node-wiring-'));
  });

  afterEach(() => {
    clearSettingsCache();
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadSettings(), saveApprovalRule(), and saveDeviceName() round-trip YAML settings cleanly', () => {
    const yamlPath = writeTempSettingsYaml(tmpDir, {
      screening: { enabled: false },
      device: { id: 'dev-baseline-1', name: 'initial-laptop' },
      checkpoints: { enabled: true },
      approvals: { rules: {} },
    });

    const initial = loadSettings(yamlPath);
    expect(initial.device).toEqual({ id: 'dev-baseline-1', name: 'initial-laptop' });
    expect(initial.approvals.rules).toEqual({});

    // Save a capability rule and verify persistence on disk
    const savedRule = saveApprovalRule('calendar.write');
    expect(savedRule.isValid).toBe(true);
    expect((savedRule.parsedValue as AppSettings['approvals']).rules).toEqual({
      'calendar.write': 'allow',
    });

    // Reload and rename device, ensuring device.id and prior approvals.rules stay intact
    const afterRule = loadSettings(yamlPath);
    expect(afterRule.approvals.rules).toEqual({ 'calendar.write': 'allow' });

    const savedDevice = saveDeviceName('studio-macbook', afterRule.device.id);
    expect(savedDevice.isValid).toBe(true);

    clearSettingsCache();
    const finalSettings = loadSettings(yamlPath);
    expect(finalSettings.device).toEqual({ id: 'dev-baseline-1', name: 'studio-macbook' });
    expect(finalSettings.approvals.rules).toEqual({ 'calendar.write': 'allow' });
    expect(AppSettingsSchema.safeParse(finalSettings).success).toBe(true);
  });

  test('AppSettingsSchema & loadSettings() produce AppSettings accepted by createHarness() and solenoid-security', async () => {
    const yamlPath = writeTempSettingsYaml(tmpDir, {
      screening: { enabled: false },
      device: { id: 'dev-yaml-1', name: 'yaml-macbook' },
      checkpoints: { enabled: true },
      approvals: {
        rules: {
          'calendar.write': 'allow',
          email_send: 'deny',
          '*': 'ask',
        },
      },
    });

    const settings: AppSettings = loadSettings(yamlPath);
    expect(AppSettingsSchema.safeParse(settings).success).toBe(true);

    // Canonical capability derivation via @elicollinson/solenoid-security
    expect(capabilityFor('calendar_create')).toBe('calendar.write');
    expect(capabilityFor('google-calendar_create_event')).toBe('google-calendar.write');
    expect(capabilityFor('remote-create-pages')).toBe('remote.write');
    expect(capabilityFor('standalone')).toBe('standalone.write');

    // YAML approvals.rules adapts cleanly into solenoid-security's PermissionStore
    const permissionStore: PermissionStore = {
      getPersonRules: () => settings.approvals.rules,
    };
    const personRules: PermissionRules = permissionStore.getPersonRules!();

    expect(resolvePermission(personRules, {}, 'calendar_create')).toBe('allow');
    expect(resolvePermission(personRules, {}, 'calendar_update')).toBe('allow');
    expect(resolvePermission(personRules, {}, 'email_send')).toBe('deny');
    expect(resolvePermission(personRules, {}, 'notes_create')).toBe('ask');
    // Layered deny precedence: agent deny beats person allow; person deny beats agent allow
    expect(resolvePermission(personRules, { 'calendar.write': 'deny' }, 'calendar_create')).toBe(
      'deny'
    );
    expect(resolvePermission(personRules, { email_send: 'allow' }, 'email_send')).toBe('deny');

    // Settings accepted directly by @elicollinson/solenoid-engine's createHarness()
    const provider = new ScriptedProvider('scripted', [say('ok')]);
    const store = new SqliteCheckpointStore(':memory:');
    const harness = await createHarness(settings, {
      routes: [{ client: provider, model: 'scripted-model' }],
      screener: null,
      checkpointStore: store,
      baseTools: [],
    });
    try {
      expect(harness.routes).toEqual([{ provider: 'scripted', model: 'scripted-model' }]);
      expect(harness.settings.device).toEqual({ id: 'dev-yaml-1', name: 'yaml-macbook' });
      expect(harness.settings.approvals.rules).toEqual({
        'calendar.write': 'allow',
        email_send: 'deny',
        '*': 'ask',
      });
    } finally {
      await harness.close();
    }
  });

  test('y / n / a approval persistence writes canonical capabilityFor(tool) to YAML and live-updates harness.setApprovalRules()', async () => {
    const yamlPath = writeTempSettingsYaml(tmpDir, {
      screening: { enabled: false },
      device: { id: 'dev-approval-1', name: 'approval-mac' },
      checkpoints: { enabled: true },
      approvals: { rules: {} },
    });

    const initialSettings = loadSettings(yamlPath);
    const calLog = { created: [] as string[], updated: [] as string[] };
    const notesLog: string[] = [];
    const { calendarCreate, calendarUpdate } = makeCalendarTools(calLog);
    const notesCreate = makeNotesWriteTool(notesLog);

    const provider = new ScriptedProvider('scripted', [
      // Turn 1: `n` (decline)
      call('calendar_create', { title: 'Declined Event' }, 'c1'),
      say('Skipped creating event.'),
      // Turn 2: `y` (allow once — does NOT persist)
      call('calendar_create', { title: 'Once Event' }, 'c2'),
      say('Created once.'),
      // Turn 3: `a` (always allow — persists canonical capability `calendar.write`)
      call('calendar_create', { title: 'Always Event' }, 'c3'),
      say('Created and remembered.'),
      // Turn 4: same capability (`calendar_update` -> `calendar.write`) runs with ZERO prompt
      call('calendar_update', { id: 'evt-42' }, 'c4'),
      say('Updated without asking.'),
      // Turn 5: different capability (`notes_create` -> `notes.write`) still asks
      call('notes_create', { text: 'Other family' }, 'c5'),
      say('Note declined.'),
    ]);

    const store = new SqliteCheckpointStore(':memory:');
    const harness = await createHarness(initialSettings, {
      routes: [{ client: provider, model: 'scripted-model' }],
      screener: null,
      checkpointStore: store,
      baseTools: [calendarCreate, calendarUpdate, notesCreate],
    });

    try {
      // Guard: fail fast before sending if options.routes is not yet wired (zero network I/O).
      expect(harness.routes).toEqual([{ provider: 'scripted', model: 'scripted-model' }]);

      const session = harness.createSession();
      const promptsSeen: string[] = [];

      const runWithDecision = async (
        prompt: string,
        decision: 'allow' | 'always' | 'decline' | 'expect-none'
      ) => {
        let thread = [...session.messages];
        let prompted = false;
        const reply = await session.send(prompt, {
          onEvent: (event: AGUIEvent) => {
            thread = applyEvent(thread, event);
            if (event.type !== EventType.RUN_FINISHED || event.outcome?.type !== 'interrupt') {
              return;
            }
            const hit = event.outcome.interrupts.find((i) => i.reason === APPROVAL_REASON);
            if (!hit) return;

            prompted = true;
            const matchedCall = hit.toolCallId ? findToolCall(thread, hit.toolCallId) : undefined;
            const toolName = matchedCall?.function.name ?? '';
            promptsSeen.push(toolName);
            expect(parseToolArgs(matchedCall?.function.arguments ?? '{}')).toBeDefined();

            if (decision === 'expect-none') {
              session.resume([approvalAnswer(hit.id, 'decline')]);
              throw new Error(`Unexpected approval prompt for ${toolName}`);
            }

            if (decision === 'always') {
              // Ensure settingsPath points to temp YAML (updateSection clears cache after writes).
              loadSettings(yamlPath);
              const canonicalCapability = capabilityFor(toolName);
              expect(canonicalCapability).toBe('calendar.write');
              const saved = saveApprovalRule(canonicalCapability);
              expect(saved.isValid).toBe(true);
              const nextRules = (saved.parsedValue as AppSettings['approvals']).rules;
              expect(nextRules[canonicalCapability]).toBe('allow');
              harness.setApprovalRules(nextRules);
            }

            session.resume([approvalAnswer(hit.id, decision === 'decline' ? 'decline' : 'allow')]);
          },
        });
        return { reply, prompted };
      };

      // 1. `n` (decline): tool does not run, nothing persisted
      const t1 = await runWithDecision('Create declined event', 'decline');
      expect(t1.prompted).toBe(true);
      expect(calLog.created).toEqual([]);
      clearSettingsCache();
      expect(loadSettings(yamlPath).approvals.rules).toEqual({});

      // 2. `y` (allow once): tool runs once, still nothing persisted
      const t2 = await runWithDecision('Create once event', 'allow');
      expect(t2.prompted).toBe(true);
      expect(calLog.created).toEqual(['Once Event']);
      clearSettingsCache();
      expect(loadSettings(yamlPath).approvals.rules).toEqual({});

      // 3. `a` (always allow): persists `calendar.write: allow` to YAML & updates live harness
      const t3 = await runWithDecision('Create always event', 'always');
      expect(t3.prompted).toBe(true);
      expect(calLog.created).toEqual(['Once Event', 'Always Event']);

      const rawYaml = readFileSync(yamlPath, 'utf-8');
      expect(rawYaml).toContain('calendar.write: allow');
      clearSettingsCache();
      const reloaded = loadSettings(yamlPath);
      expect(reloaded.approvals.rules).toEqual({ 'calendar.write': 'allow' });
      expect(resolvePermission(reloaded.approvals.rules, {}, 'calendar_create')).toBe('allow');
      expect(resolvePermission(reloaded.approvals.rules, {}, 'calendar_update')).toBe('allow');

      // 4. Subsequent write in same capability (`calendar_update`) bypasses interrupt immediately
      const t4 = await runWithDecision('Update event 42', 'expect-none');
      expect(t4.prompted).toBe(false);
      expect(calLog.updated).toEqual(['evt-42']);

      // 5. Write in another capability (`notes_create`) still prompts
      const t5 = await runWithDecision('Create note', 'decline');
      expect(t5.prompted).toBe(true);
      expect(notesLog).toEqual([]);
      expect(promptsSeen).toEqual([
        'calendar_create',
        'calendar_create',
        'calendar_create',
        'notes_create',
      ]);
    } finally {
      await harness.close();
    }
  });

  test('YAML approvals.rules adapts cleanly into solenoid-security ApprovalBroker with opaque choice IDs', async () => {
    const yamlPath = writeTempSettingsYaml(tmpDir, {
      screening: { enabled: false },
      approvals: {
        rules: {
          'calendar.write': 'allow',
          notes_delete: 'deny',
        },
      },
    });

    const permissionStore: PermissionStore = {
      getPersonRules: () => {
        clearSettingsCache();
        return loadSettings(yamlPath).approvals.rules;
      },
    };

    const approvalStore = new InMemoryApprovalStore();
    const broker = new ApprovalBroker({ store: approvalStore });
    const opened: ApprovalRecord[] = [];

    const gate = withPermissions<ToolRequest>(
      (tool) => resolvePermission(permissionStore.getPersonRules!(), {}, tool),
      async (request) => {
        const result = await broker.askBlocking({
          request,
          choices: [
            { label: 'Allow', stance: 'affirm', approves: true },
            { label: 'Always allow', stance: 'neutral', approves: true },
            { label: 'Decline', stance: 'quiet', approves: false },
          ],
          onOpened: (record) => opened.push(record),
        });
        return result.verdict;
      }
    );

    // Read tools ALWAYS bypass gating, even under `{ '*': 'deny' }`
    const strictReadGate = withPermissions<ToolRequest>(
      () => 'deny',
      () => {
        throw new Error('ask should never be called for read tools');
      }
    );
    expect(
      await strictReadGate({
        tool: 'notes_read',
        kind: 'read',
        args: { id: '1' },
        description: 'Read a note',
      })
    ).toEqual({ allow: true });

    // Standing YAML rules answer allow and deny without opening an approval record
    expect(
      await gate({
        tool: 'calendar_create',
        kind: 'write',
        args: { title: 'Sync' },
        description: 'Create calendar event',
      })
    ).toEqual({ allow: true });
    expect(opened).toHaveLength(0);

    const denied = await gate({
      tool: 'notes_delete',
      kind: 'write',
      args: { id: 'n1' },
      description: 'Delete a note',
    });
    expect(denied.allow).toBe(false);
    expect(opened).toHaveLength(0);

    // Unmatched write opens a blocking broker approval with opaque choice IDs
    const writeArgs = { title: 'Buy milk', list: 'groceries' };
    const pendingAsk = gate({
      tool: 'reminders_create',
      kind: 'write',
      args: writeArgs,
      description: 'Create a reminder',
    });

    // Wait a microtask for onOpened
    await Promise.resolve();
    expect(opened).toHaveLength(1);
    const record = opened[0]!;
    expect(record.tool).toBe('reminders_create');
    expect(record.capability).toBe('reminders.write');
    expect(record.argsDigest).toBe(computeArgsDigest(writeArgs));

    const alwaysChoice = record.choices.find((c) => c.label === 'Always allow');
    const declineChoice = record.choices.find((c) => c.label === 'Decline');
    expect(alwaysChoice).toBeDefined();
    expect(declineChoice).toBeDefined();
    // Choice IDs are opaque (not raw booleans or labels) and distinct
    expect(alwaysChoice!.id).not.toBe('allow');
    expect(alwaysChoice!.id).not.toBe('true');
    expect(alwaysChoice!.id).not.toBe(declineChoice!.id);
    expect(alwaysChoice!.id).not.toBe(record.id);

    // Forged / mutated argsDigest is rejected without settling
    await expect(
      broker.answerChoice({
        choiceId: alwaysChoice!.id,
        expectedArgsDigest: '0'.repeat(64),
      })
    ).rejects.toBeInstanceOf(ApprovalDigestMismatchError);
    expect(broker.isPending(record.id)).toBe(true);

    // Valid opaque choice settles once and persists canonical capability into YAML
    const answer = await broker.answerChoice({
      choiceId: alwaysChoice!.id,
      expectedArgsDigest: record.argsDigest,
    });
    expect(answer.outcome).toBe('approved');
    expect(await pendingAsk).toEqual({ allow: true });

    // Double-settlement throws AlreadySettledError
    await expect(broker.answerChoice({ choiceId: declineChoice!.id })).rejects.toBeInstanceOf(
      AlreadySettledError
    );

    // Persisting canonical capability updates PermissionStore immediately for sibling writes
    loadSettings(yamlPath);
    const saved = saveApprovalRule(capabilityFor(record.tool));
    expect(saved.isValid).toBe(true);

    expect(
      await gate({
        tool: 'reminders_complete',
        kind: 'write',
        args: { id: 'r1' },
        description: 'Complete reminder',
      })
    ).toEqual({ allow: true });
    // No second broker record opened
    expect(opened).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Headless CLI / Session parity via @elicollinson/solenoid-engine
// ---------------------------------------------------------------------------

describe('3. Headless CLI / Session parity via @elicollinson/solenoid-engine (100% offline)', () => {
  let tmpDir = '';

  beforeEach(() => {
    clearSettingsCache();
    tmpDir = mkdtempSync(join(tmpdir(), 'solenoid-node-cli-parity-'));
  });

  afterEach(() => {
    clearSettingsCache();
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('multi-turn sessions, /sessions, /device-name, --continue, and --resume <prefix> work offline', async () => {
    const yamlPath = writeTempSettingsYaml(tmpDir, {
      screening: { enabled: false },
      device: { id: 'dev-cli-1', name: 'old-laptop' },
      checkpoints: { enabled: true },
    });

    const settings1 = loadSettings(yamlPath);
    const realStore = new SqliteCheckpointStore(':memory:');

    try {
      const provider1 = new ScriptedProvider('scripted', [
        say('Got it, project code is Solenoid-42.'),
        say('Your project code is Solenoid-42.'),
        say('Second topic opened.'),
      ]);

      const harness1 = await createHarness(settings1, {
        routes: [{ client: provider1, model: 'scripted-model' }],
        screener: null,
        checkpointStore: sharedStoreView(realStore),
        baseTools: [makeEchoReadTool()],
      });

      let session1Id = '';
      let session2Id = '';

      try {
        expect(harness1.routes).toEqual([{ provider: 'scripted', model: 'scripted-model' }]);

        // Session 1: 2 turns
        const session1 = harness1.createSession({ canSpawn: true });
        session1Id = session1.threadId;
        expect(await session1.send('Remember project Solenoid-42.', { onEvent: () => {} })).toBe(
          'Got it, project code is Solenoid-42.'
        );
        expect(await session1.send('What is the project code?', { onEvent: () => {} })).toBe(
          'Your project code is Solenoid-42.'
        );
        expect(provider1.calls[1]?.map((m) => m.content)).toEqual([
          'Remember project Solenoid-42.',
          'Got it, project code is Solenoid-42.',
          'What is the project code?',
        ]);
        expect(session1.messages).toHaveLength(4);

        // Session 2: 1 turn (becomes latest for --continue)
        const session2 = harness1.createSession({ canSpawn: true });
        session2Id = session2.threadId;
        expect(await session2.send('Start second topic', { onEvent: () => {} })).toBe(
          'Second topic opened.'
        );

        // /sessions parity: lists top-level sessions newest first
        const beforeRename = await harness1.listSessions(10);
        expect(beforeRename.map((s) => s.id)).toEqual([session2Id, session1Id]);
        expect(beforeRename.every((s) => !s.isRemote && s.lastDeviceName === 'old-laptop')).toBe(
          true
        );

        // /device-name parity: saveDeviceName persists YAML & setDeviceName backfills SQLite
        loadSettings(yamlPath);
        const savedDev = saveDeviceName('work-macbook', harness1.settings.device.id);
        expect(savedDev.isValid).toBe(true);
        const nextDevice = savedDev.parsedValue as AppSettings['device'];
        expect(nextDevice).toEqual({ id: 'dev-cli-1', name: 'work-macbook' });

        const updatedCount = await harness1.setDeviceName(nextDevice.name);
        expect(updatedCount).toBe(2);
        expect(harness1.settings.device.name).toBe('work-macbook');

        const afterRename = await harness1.listSessions(10);
        expect(
          afterRename.every(
            (s) => s.originDeviceName === 'work-macbook' && s.lastDeviceName === 'work-macbook'
          )
        ).toBe(true);
      } finally {
        await harness1.close();
      }

      // Fresh process / harness #2 on same device & shared :memory: store
      clearSettingsCache();
      const settings2 = loadSettings(yamlPath);
      expect(settings2.device).toEqual({ id: 'dev-cli-1', name: 'work-macbook' });

      const provider2 = new ScriptedProvider('scripted', [
        say('Continuing second topic.'),
        say('Still Solenoid-42.'),
      ]);
      const harness2 = await createHarness(settings2, {
        routes: [{ client: provider2, model: 'scripted-model' }],
        screener: null,
        checkpointStore: sharedStoreView(realStore),
        baseTools: [makeEchoReadTool()],
      });

      try {
        expect(harness2.routes).toEqual([{ provider: 'scripted', model: 'scripted-model' }]);

        // --continue (resumeSession with no target resumes the latest session)
        const continued = await harness2.resumeSession(undefined, { canSpawn: true });
        expect(continued.summary.id).toBe(session2Id);
        expect(continued.isRemote).toBe(false);
        expect(await continued.session.send('Keep going on topic 2', { onEvent: () => {} })).toBe(
          'Continuing second topic.'
        );
        expect(provider2.calls[0]?.map((m) => m.content)).toEqual([
          'Start second topic',
          'Second topic opened.',
          'Keep going on topic 2',
        ]);

        // --resume <prefix> (8-char prefix resumes session 1 and restores AG-UI thread)
        const prefix = session1Id.slice(0, 8);
        const resumed = await harness2.resumeSession(prefix, { canSpawn: true });
        expect(resumed.summary.id).toBe(session1Id);
        expect(resumed.summary.lastDeviceName).toBe('work-macbook');

        const snapshotThread = applyEvent([], {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [...resumed.session.messages],
        });
        expect(snapshotThread).toHaveLength(4);

        expect(await resumed.session.send('Remind me of the code.', { onEvent: () => {} })).toBe(
          'Still Solenoid-42.'
        );
        expect(provider2.calls[1]?.map((m) => m.content)).toEqual([
          'Remember project Solenoid-42.',
          'Got it, project code is Solenoid-42.',
          'What is the project code?',
          'Your project code is Solenoid-42.',
          'Remind me of the code.',
        ]);
      } finally {
        await harness2.close();
      }

      // Remote device view: harness #3 with different device.id sees sessions as isRemote: true
      const remoteSettings = AppSettingsSchema.parse({
        screening: { enabled: false },
        device: { id: 'dev-remote-2', name: 'road-air' },
        checkpoints: { enabled: true },
      });
      const harness3 = await createHarness(remoteSettings, {
        routes: [{ client: new ScriptedProvider('scripted', []), model: 'scripted-model' }],
        screener: null,
        checkpointStore: sharedStoreView(realStore),
        baseTools: [],
      });

      try {
        const remoteList = await harness3.listSessions(10);
        expect(remoteList).toHaveLength(2);
        expect(remoteList.every((s) => s.isRemote && s.lastDeviceName === 'work-macbook')).toBe(
          true
        );
        const remoteResumed = await harness3.resumeSession(session1Id.slice(0, 8));
        expect(remoteResumed.isRemote).toBe(true);
      } finally {
        await harness3.close();
      }
    } finally {
      await realStore.close();
    }
  });

  test('--yes ({ "*": "allow" }) allows writes unattended while default unattended declines writes and allows reads', async () => {
    const calLog = { created: [] as string[], updated: [] as string[] };
    const readLog: string[] = [];
    const { calendarCreate } = makeCalendarTools(calLog);
    const echoRead = makeEchoReadTool(readLog);

    const settings = AppSettingsSchema.parse({
      screening: { enabled: false },
      device: { id: 'dev-yes-1', name: 'cli-box' },
      checkpoints: { enabled: true },
      approvals: { rules: {} },
    });

    const provider = new ScriptedProvider('scripted', [
      // Run 1: default unattended (no --yes) -> read runs, write is declined
      call('echo_read', { text: 'ping' }, 'r1'),
      call('calendar_create', { title: 'Blocked' }, 'w1'),
      say('Could not create unattended.'),
      // Run 2: --yes (`{ '*': 'allow' }`) -> write runs without asking
      call('calendar_create', { title: 'Allowed By Yes' }, 'w2'),
      say('Created with --yes.'),
      // Run 3: agent-level deny still beats person `{ '*': 'allow' }`
      call('calendar_create', { title: 'Denied By Profile' }, 'w3'),
      say('Denied by profile.'),
    ]);

    const store = new SqliteCheckpointStore(':memory:');
    const harness = await createHarness(settings, {
      routes: [{ client: provider, model: 'scripted-model' }],
      screener: null,
      checkpointStore: store,
      baseTools: [echoRead, calendarCreate],
    });

    try {
      expect(harness.routes).toEqual([{ provider: 'scripted', model: 'scripted-model' }]);

      // 1. Unattended default (`declineUnattended` from @elicollinson/solenoid-security)
      const unattendedSession = harness.createSession({ approve: declineUnattended });
      await unattendedSession.send('Read and write', { onEvent: () => {} });
      expect(readLog).toEqual(['ping']);
      expect(calLog.created).toEqual([]);
      const declinedMsg = provider.calls[2]?.find(
        (m) => m.role === 'tool' && m.toolCallId === 'w1'
      );
      expect(declinedMsg?.content.toLowerCase()).toContain('unattended');

      // 2. `--yes` parity: standing rule `{ '*': 'allow' }`
      harness.setApprovalRules({ '*': 'allow' });
      const yesSession = harness.createSession({ approve: declineUnattended });
      expect(await yesSession.send('Write with yes', { onEvent: () => {} })).toBe(
        'Created with --yes.'
      );
      expect(calLog.created).toEqual(['Allowed By Yes']);

      // 3. Profile-level `deny` still overrides `{ '*': 'allow' }`
      const lockedSession = harness.createSession({
        permissions: { 'calendar.write': 'deny' },
        approve: declineUnattended,
      });
      await lockedSession.send('Write under deny profile', { onEvent: () => {} });
      expect(calLog.created).toEqual(['Allowed By Yes']);
    } finally {
      await harness.close();
    }
  });

  test('background subagents and onAutoTurn work end-to-end through createHarness({ canSpawn: true })', async () => {
    const childGate = Promise.withResolvers<void>();
    const readLog: string[] = [];
    const echoRead = makeEchoReadTool(readLog);

    const provider = new RoutedScriptedProvider(
      'scripted',
      // Parent steps
      [
        call('spawn_subagent', { name: 'researcher', task: 'Count widgets' }, 'sp1'),
        say('Spawned researcher; I will report back.'),
        say('Final report: 42 widgets.'),
      ],
      // Child steps (gated until parent finishes its opening turn)
      [
        async () => {
          await childGate.promise;
          return call('echo_read', { text: 'widgets=42' }, 'cr1');
        },
        say('Widgets count is 42.'),
      ]
    );

    const settings = AppSettingsSchema.parse({
      screening: { enabled: false },
      device: { id: 'dev-sub-1', name: 'subagent-mac' },
      checkpoints: { enabled: true },
    });
    const store = new SqliteCheckpointStore(':memory:');
    const harness = await createHarness(settings, {
      routes: [{ client: provider, model: 'scripted-model' }],
      screener: null,
      checkpointStore: store,
      baseTools: [echoRead],
    });

    try {
      expect(harness.routes).toEqual([{ provider: 'scripted', model: 'scripted-model' }]);

      const session = harness.createSession({ canSpawn: true, approve: declineUnattended });
      const answers: string[] = [];
      const autoTurnEvents: AGUIEvent[] = [];

      session.onAutoTurn((turn: AutoTurn) => {
        turn({ onEvent: (e) => autoTurnEvents.push(e) }).then((reply) => {
          answers.push(reply);
        });
      });

      answers.push(await session.send('How many widgets do we have?', { onEvent: () => {} }));
      expect(answers).toEqual(['Spawned researcher; I will report back.']);

      // Release child subagent and wait for automatic follow-up turn to settle
      childGate.resolve();
      await session.idle();

      expect(readLog).toEqual(['widgets=42']);
      expect(answers).toEqual([
        'Spawned researcher; I will report back.',
        'Final report: 42 widgets.',
      ]);

      // Parent auto-turn saw the child's finding as a developer news message
      const devMessage = session.messages.find((m) => m.role === 'developer');
      expect(devMessage?.content).toContain('Subagents finished:');
      expect(devMessage?.content).toContain('Widgets count is 42.');
      expect(
        autoTurnEvents.some(
          (e) => e.type === EventType.TEXT_MESSAGE_START && e.role === 'developer'
        )
      ).toBe(true);

      // Child subagent checkpoint is linked by parentId and excluded from top-level /sessions
      const topLevel = await harness.listSessions(10);
      expect(topLevel).toHaveLength(1);
      expect(topLevel[0]?.id).toBe(session.threadId);
    } finally {
      childGate.resolve();
      await harness.close();
    }
  });

  test('Phase 2 mid-turn interrupt checkpoint persists and resumes across restart via harness.resumeSession() (approve & decline)', async () => {
    const runRestartScenario = async (choice: 'allow' | 'decline') => {
      const calLog = { created: [] as string[], updated: [] as string[] };
      const { calendarCreate } = makeCalendarTools(calLog);
      const realStore = new SqliteCheckpointStore(':memory:');
      let crashed = false;

      const settings = AppSettingsSchema.parse({
        screening: { enabled: false },
        device: { id: 'dev-phase2-1', name: 'crash-test-mac' },
        checkpoints: { enabled: true },
        approvals: { rules: {} },
      });

      try {
        const provider1 = new ScriptedProvider('scripted', [
          call('calendar_create', { title: 'Daily Standup' }, 'w-standup'),
        ]);
        const harness1 = await createHarness(settings, {
          routes: [{ client: provider1, model: 'scripted-model' }],
          screener: null,
          checkpointStore: sharedStoreView(realStore, () => crashed),
          baseTools: [calendarCreate],
        });

        let sessionId = '';
        let interruptId = '';
        const abort1 = new AbortController();
        let sendSettled: Promise<void> | undefined;

        try {
          expect(harness1.routes).toEqual([{ provider: 'scripted', model: 'scripted-model' }]);

          const session1 = harness1.createSession();
          sessionId = session1.threadId;

          let resolvePaused!: (id: string) => void;
          const paused = new Promise<string>((resolve) => {
            resolvePaused = resolve;
          });

          sendSettled = session1
            .send('Schedule Daily Standup', {
              signal: abort1.signal,
              onEvent: (event) => {
                if (event.type === EventType.RUN_FINISHED && event.outcome?.type === 'interrupt') {
                  const hit = event.outcome.interrupts.find((i) => i.reason === APPROVAL_REASON);
                  if (hit) resolvePaused(hit.id);
                }
              },
            })
            .then(
              (output) => {
                throw new Error(`Expected approval interrupt, but turn completed: ${output}`);
              },
              (err) => {
                if (!crashed) throw err;
              }
            );

          interruptId = await Promise.race([paused, sendSettled as Promise<never>]);
          await Promise.resolve();

          // Durable Phase 2 interrupt checkpoint must already be persisted in SQLite
          const beforeRestart = await realStore.load(sessionId);
          expect(beforeRestart?.session.status).toBe('waiting_approval');
          expect(beforeRestart?.checkpoint.kind).toBe('interrupt');
          const pendingState = beforeRestart?.checkpoint.pending as
            | PendingCheckpointState
            | undefined;
          expect(pendingState?.interrupts).toHaveLength(1);
          expect(pendingState?.interrupts[0]).toMatchObject({
            interruptId,
            toolCallId: 'w-standup',
            tool: 'calendar_create',
            args: { title: 'Daily Standup' },
          });
          expect(calLog.created).toEqual([]);
        } finally {
          // Simulate abrupt process crash: freeze store writes from process 1, then clean up handles
          crashed = true;
          abort1.abort();
          await sendSettled?.catch(() => {});
          await harness1.close();
        }

        // Process 2: fresh harness & fresh provider resume the interrupted session by prefix
        const expectedReply =
          choice === 'allow' ? 'Daily Standup scheduled.' : 'Cancelled scheduling Daily Standup.';
        const provider2 = new ScriptedProvider('scripted', [say(expectedReply)]);
        const harness2 = await createHarness(settings, {
          routes: [{ client: provider2, model: 'scripted-model' }],
          screener: null,
          checkpointStore: sharedStoreView(realStore),
          baseTools: [calendarCreate],
        });

        try {
          const resumed = await harness2.resumeSession(sessionId.slice(0, 8));
          expect(resumed.summary.id).toBe(sessionId);
          expect(resumed.summary.status).toBe('waiting_approval');
          expect(resumed.session.pendingInterrupts).toHaveLength(1);
          expect(resumed.session.pendingInterrupts[0]).toMatchObject({
            interruptId,
            toolCallId: 'w-standup',
            tool: 'calendar_create',
          });

          const resumedEvents: AGUIEvent[] = [];
          const finalReply = await resumed.session.continueFromInterrupt(
            [approvalAnswer(interruptId, choice)],
            { onEvent: (e) => resumedEvents.push(e) }
          );

          expect(finalReply).toBe(expectedReply);
          const toolResult = provider2.calls[0]?.find(
            (m) => m.role === 'tool' && m.toolCallId === 'w-standup'
          );
          if (choice === 'allow') {
            // Tool executed exactly once across the crash + restart
            expect(calLog.created).toEqual(['Daily Standup']);
            expect(toolResult?.content).toBe('created:Daily Standup');
          } else {
            // Declined write never ran, and the model was told why
            expect(calLog.created).toEqual([]);
            expect(toolResult?.content.toLowerCase()).toContain('declined');
          }

          // Checkpoint transitioned cleanly to idle / turn_end
          const afterResume = await realStore.load(sessionId);
          expect(afterResume?.session.status).toBe('idle');
          expect(afterResume?.checkpoint.kind).toBe('turn_end');
          expect(resumedEvents.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
        } finally {
          await harness2.close();
        }
      } finally {
        await realStore.close();
      }
    };

    await runRestartScenario('allow');
    await runRestartScenario('decline');
  });
});
