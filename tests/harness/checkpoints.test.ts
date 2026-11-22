/**
 * Session Checkpoints & Resume Tests
 *
 * Covers:
 * - Local SQLite checkpoint persistence, prefix lookup, and device rename backfill
 * - Remote Supabase connector and CompositeCheckpointStore cross-device resume
 * - Session & Harness between-turn checkpointing, multi-turn resume, and
 *   retroactive `/device-name` updates
 */
import { describe, expect, test } from 'bun:test';
import { type AGUIEvent, EventType } from '@ag-ui/core';
import { z } from 'zod';
import { AppSettingsSchema } from '../../src/config/index.js';
import { Agent, defineTool } from '../../src/core/index.js';
import {
  APPROVAL_REASON,
  CompositeCheckpointStore,
  Session,
  SqliteCheckpointStore,
  SupabaseCheckpointStore,
  applyEvent,
  createHarness,
  supabaseSchemaSql,
} from '../../src/harness/index.js';
import { ScriptedProvider, call, say } from '../helpers/scripted-provider.js';

/** In-memory mock of Supabase PostgREST endpoints for sessions and checkpoints. */
function createMockSupabaseFetch() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    solenoid_sessions: [],
    solenoid_checkpoints: [],
  };

  const matchRow = (row: Record<string, unknown>, expr: string): boolean => {
    const eqIdx = expr.indexOf('.eq.');
    if (eqIdx !== -1) {
      const col = expr.slice(0, eqIdx);
      const val = decodeURIComponent(expr.slice(eqIdx + 4));
      return String(row[col]) === val;
    }
    const likeIdx = expr.indexOf('.like.');
    if (likeIdx !== -1) {
      const col = expr.slice(0, likeIdx);
      const pattern = decodeURIComponent(expr.slice(likeIdx + 6)).replace(/\*$/, '');
      return String(row[col] ?? '').startsWith(pattern);
    }
    const isIdx = expr.indexOf('.is.');
    if (isIdx !== -1) {
      const col = expr.slice(0, isIdx);
      const val = expr.slice(isIdx + 4);
      if (val === 'null') return row[col] == null;
    }
    return true;
  };

  const filterRows = (rows: Array<Record<string, unknown>>, searchParams: URLSearchParams) => {
    return rows.filter((row) => {
      for (const [key, value] of searchParams.entries()) {
        if (key === 'select' || key === 'on_conflict' || key === 'order' || key === 'limit') {
          continue;
        }
        if (key === 'or') {
          const inner = value.replace(/^\(|\)$/g, '');
          const branches = inner.split(',');
          if (!branches.some((b) => matchRow(row, b))) return false;
          continue;
        }
        if (!matchRow(row, `${key}.${value}`)) return false;
      }
      return true;
    });
  };

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    );
    const table = url.pathname.split('/').pop()!;
    const rows = tables[table] ?? [];
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      let matched = filterRows(rows, url.searchParams);
      const order = url.searchParams.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        matched = [...matched].sort((a, b) => {
          const av = a[col!];
          const bv = b[col!];
          const cmp =
            typeof av === 'number' && typeof bv === 'number'
              ? av - bv
              : String(av).localeCompare(String(bv));
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      const limit = url.searchParams.get('limit');
      if (limit) matched = matched.slice(0, Number(limit));
      return new Response(JSON.stringify(matched), { status: 200 });
    }

    if (method === 'POST') {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const conflictCols = (url.searchParams.get('on_conflict') ?? 'id').split(',');
      const existingIdx = rows.findIndex((r) => conflictCols.every((c) => r[c] === payload[c]));
      if (existingIdx >= 0) {
        rows[existingIdx] = { ...rows[existingIdx], ...payload };
      } else {
        rows.push({ ...payload });
      }
      return new Response('', { status: 201 });
    }

    if (method === 'PATCH') {
      const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const matched = filterRows(rows, url.searchParams);
      for (const row of matched) {
        Object.assign(row, patch);
      }
      return new Response(JSON.stringify(matched), { status: 200 });
    }

    if (method === 'DELETE') {
      const matched = new Set(filterRows(rows, url.searchParams));
      tables[table] = rows.filter((r) => !matched.has(r));
      return new Response('', { status: 204 });
    }

    return new Response('Unsupported', { status: 405 });
  }) as typeof fetch;

  return { fetchFn, tables };
}

describe('SqliteCheckpointStore', () => {
  test('saves checkpoints, loads by exact ID or prefix, and lists top-level sessions', async () => {
    const store = new SqliteCheckpointStore(':memory:');
    const device = { id: 'dev-local', name: 'macbook-pro' };

    const meta1 = await store.save({
      sessionId: '11111111-aaaa-bbbb-cccc-000000000001',
      status: 'running',
      kind: 'turn_start',
      device,
      transcript: [{ role: 'user', content: 'Explain solenoid valves', origin: 'operator' }],
      thread: [{ id: 'm1', role: 'user', content: 'Explain solenoid valves' }],
    });
    expect(meta1).toEqual({ seq: 1, turnStartSeq: 1 });

    const meta2 = await store.save({
      sessionId: '11111111-aaaa-bbbb-cccc-000000000001',
      status: 'idle',
      kind: 'turn_end',
      device,
      turnStartSeq: meta1.turnStartSeq,
      transcript: [
        { role: 'user', content: 'Explain solenoid valves', origin: 'operator', screened: true },
        { role: 'assistant', content: 'An electromechanically operated valve.', screened: true },
      ],
      thread: [
        { id: 'm1', role: 'user', content: 'Explain solenoid valves' },
        { id: 'm2', role: 'assistant', content: 'An electromechanically operated valve.' },
      ],
    });
    expect(meta2).toEqual({ seq: 2, turnStartSeq: 1 });

    // Child subagent session is saved with parentId and excluded from top-level list()
    await store.save({
      sessionId: 'child-sa-1',
      parentId: '11111111-aaaa-bbbb-cccc-000000000001',
      status: 'idle',
      kind: 'turn_end',
      device,
      transcript: [{ role: 'user', content: 'Subtask' }],
      thread: [],
    });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: '11111111-aaaa-bbbb-cccc-000000000001',
      title: 'Explain solenoid valves',
      status: 'idle',
      originDeviceId: 'dev-local',
      originDeviceName: 'macbook-pro',
      lastDeviceId: 'dev-local',
      lastDeviceName: 'macbook-pro',
      lastSeq: 2,
    });

    // Prefix lookup
    const byPrefix = await store.load('11111111');
    expect(byPrefix?.checkpoint.seq).toBe(2);
    expect(byPrefix?.checkpoint.transcript).toHaveLength(2);
    expect(byPrefix?.checkpoint.thread).toHaveLength(2);

    await store.close();
  });

  test('renameDevice updates historic sessions and checkpoints for that device only', async () => {
    const store = new SqliteCheckpointStore(':memory:');
    const deviceA = { id: 'dev-a', name: 'old-laptop' };
    const deviceB = { id: 'dev-b', name: 'remote-desktop' };

    // Session 1: started and run on device A
    await store.save({
      sessionId: 'sess-1',
      status: 'idle',
      kind: 'turn_end',
      device: deviceA,
      transcript: [{ role: 'user', content: 'First on A' }],
      thread: [],
    });

    // Session 2: started on device A, resumed on device B
    await store.save({
      sessionId: 'sess-2',
      status: 'idle',
      kind: 'turn_end',
      device: deviceA,
      transcript: [{ role: 'user', content: 'Started on A' }],
      thread: [],
    });
    await store.save({
      sessionId: 'sess-2',
      status: 'idle',
      kind: 'turn_end',
      device: deviceB,
      transcript: [
        { role: 'user', content: 'Started on A' },
        { role: 'user', content: 'Continued on B' },
      ],
      thread: [],
    });

    // Session 3: solely on device B
    await store.save({
      sessionId: 'sess-3',
      status: 'idle',
      kind: 'turn_end',
      device: deviceB,
      transcript: [{ role: 'user', content: 'Only on B' }],
      thread: [],
    });

    const updatedCount = await store.renameDevice('dev-a', 'work-macbook', 'old-laptop');
    expect(updatedCount).toBe(2);

    const s1 = await store.load('sess-1');
    expect(s1?.session.originDeviceName).toBe('work-macbook');
    expect(s1?.session.lastDeviceName).toBe('work-macbook');
    expect(s1?.checkpoint.deviceName).toBe('work-macbook');

    const s2 = await store.load('sess-2');
    expect(s2?.session.originDeviceName).toBe('work-macbook');
    expect(s2?.session.lastDeviceName).toBe('remote-desktop');
    expect(s2?.checkpoint.deviceName).toBe('remote-desktop');

    const s3 = await store.load('sess-3');
    expect(s3?.session.originDeviceName).toBe('remote-desktop');
    expect(s3?.session.lastDeviceName).toBe('remote-desktop');

    await store.close();
  });
});

describe('CompositeCheckpointStore (SQLite + Supabase cross-device sync)', () => {
  test('resumes a session created on a remote device and syncs device renames', async () => {
    const { fetchFn } = createMockSupabaseFetch();
    const remote = new SupabaseCheckpointStore(
      { url: 'https://example.supabase.co', apiKey: 'test-key', tablePrefix: 'solenoid_' },
      { fetchFn }
    );

    // Device 1 (remote studio machine) saves a session to Supabase
    const remoteLocalDb = new SqliteCheckpointStore(':memory:');
    const remoteComposite = new CompositeCheckpointStore(remoteLocalDb, remote);
    const remoteDevice = { id: 'dev-remote-1', name: 'studio-mac-mini' };

    await remoteComposite.save({
      sessionId: 'remote-session-1234',
      status: 'idle',
      kind: 'turn_end',
      device: remoteDevice,
      transcript: [
        { role: 'user', content: 'Hello from studio', origin: 'operator', screened: true },
        { role: 'assistant', content: 'Hi from studio model!', screened: true },
      ],
      thread: [
        { id: 'u1', role: 'user', content: 'Hello from studio' },
        { id: 'a1', role: 'assistant', content: 'Hi from studio model!' },
      ],
    });

    // Device 2 (local laptop) connects to the same Supabase with a fresh local SQLite DB
    const laptopLocalDb = new SqliteCheckpointStore(':memory:');
    const laptopComposite = new CompositeCheckpointStore(laptopLocalDb, remote);
    const laptopDevice = { id: 'dev-laptop-2', name: 'road-macbook' };

    const listed = await laptopComposite.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.lastDeviceId).toBe('dev-remote-1');
    expect(listed[0]?.lastDeviceName).toBe('studio-mac-mini');

    // Load the remote session on the laptop (also caches it into laptopLocalDb)
    const loaded = await laptopComposite.load('remote-session');
    expect(loaded?.session.id).toBe('remote-session-1234');
    expect(loaded?.session.originDeviceName).toBe('studio-mac-mini');
    expect(loaded?.checkpoint.transcript).toHaveLength(2);

    // Laptop runs turn 2 on the resumed session
    await laptopComposite.save({
      sessionId: 'remote-session-1234',
      status: 'idle',
      kind: 'turn_end',
      device: laptopDevice,
      transcript: [
        ...loaded!.checkpoint.transcript,
        { role: 'user', content: 'Follow up from laptop', origin: 'operator', screened: true },
        { role: 'assistant', content: 'Continued on laptop!', screened: true },
      ],
      thread: [...loaded!.checkpoint.thread],
    });

    const afterTurn2 = await laptopComposite.load('remote-session-1234');
    expect(afterTurn2?.session.originDeviceId).toBe('dev-remote-1');
    expect(afterTurn2?.session.originDeviceName).toBe('studio-mac-mini');
    expect(afterTurn2?.session.lastDeviceId).toBe('dev-laptop-2');
    expect(afterTurn2?.session.lastDeviceName).toBe('road-macbook');
    expect(afterTurn2?.checkpoint.seq).toBe(2);

    // Rename laptop device and verify both local SQLite and remote Supabase update
    await laptopComposite.renameDevice('dev-laptop-2', 'eli-air', 'road-macbook');
    const afterRename = await remote.load('remote-session-1234');
    expect(afterRename?.session.originDeviceName).toBe('studio-mac-mini');
    expect(afterRename?.session.lastDeviceName).toBe('eli-air');
    expect(afterRename?.checkpoint.deviceName).toBe('eli-air');

    await remoteComposite.close();
    await laptopComposite.close();
  });

  test('supabaseSchemaSql generates valid DDL with RLS and indexes', () => {
    const sql = supabaseSchemaSql('solenoid_');
    expect(sql).toContain('create table if not exists public.solenoid_sessions');
    expect(sql).toContain('create table if not exists public.solenoid_checkpoints');
    expect(sql).toContain('enable row level security');
    expect(() => supabaseSchemaSql('drop table; --')).toThrow('Invalid table prefix');
  });
});

describe('Session between-turn checkpointing and resume', () => {
  test('a resumed session replays the saved transcript and restores the AG-UI thread', async () => {
    const store = new SqliteCheckpointStore(':memory:');
    const device = { id: 'dev-1', name: 'my-mac' };
    const threadId = 'session-to-resume-001';

    const makeCheckpointer = (id: string) => ({
      save: (
        cp: Parameters<typeof store.save>[0] extends infer T
          ? Omit<T, 'sessionId' | 'device'>
          : never
      ) => store.save({ ...cp, sessionId: id, device }),
      clear: () => store.delete(id),
    });

    // Process 1: Run turn 1
    const provider1 = new ScriptedProvider('fake', [say('The code is 42.')]);
    const session1 = new Session(new Agent({ routes: [{ client: provider1, model: 'm' }] }), {
      threadId,
      checkpoint: makeCheckpointer(threadId),
    });
    await session1.send('Remember code 42', { onEvent: () => {} });
    session1.close();

    // Process 2: Load checkpoint and construct resumed Session
    const loaded = await store.load(threadId);
    expect(loaded).toBeDefined();
    expect(loaded?.session.status).toBe('idle');
    expect(loaded?.checkpoint.kind).toBe('turn_end');

    const provider2 = new ScriptedProvider('fake', [say('You asked me to remember 42.')]);
    const session2 = new Session(new Agent({ routes: [{ client: provider2, model: 'm' }] }), {
      threadId: loaded!.session.id,
      initialTranscript: loaded!.checkpoint.transcript,
      initialThread: loaded!.checkpoint.thread,
      checkpoint: makeCheckpointer(loaded!.session.id),
    });

    // Client restores UI thread via MESSAGES_SNAPSHOT from session2.messages
    let clientThread = applyEvent([], {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...session2.messages],
    });
    expect(clientThread.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'Remember code 42' },
      { role: 'assistant', content: 'The code is 42.' },
    ]);

    // Turn 2 on the resumed session
    const events: AGUIEvent[] = [];
    const reply = await session2.send('What was the code?', {
      onEvent: (e) => {
        events.push(e);
        clientThread = applyEvent(clientThread, e);
      },
    });

    expect(reply).toBe('You asked me to remember 42.');
    // Provider 2 received the full 3-message history (turn 1 user + assistant, turn 2 user)
    expect(provider2.calls[0]?.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'Remember code 42' },
      { role: 'assistant', content: 'The code is 42.' },
      { role: 'user', content: 'What was the code?' },
    ]);
    expect(clientThread).toHaveLength(4);

    await store.close();
  });

  test('Harness.resumeSession, listSessions, and setDeviceName track local vs remote devices', async () => {
    const store = new SqliteCheckpointStore(':memory:');
    // Simulate a remote session already in the store from another device
    await store.save({
      sessionId: 'remote-99990000',
      status: 'idle',
      kind: 'turn_end',
      device: { id: 'dev-other', name: 'cloud-box' },
      transcript: [
        { role: 'user', content: 'Remote prompt', origin: 'operator', screened: true },
        { role: 'assistant', content: 'Remote answer', screened: true },
      ],
      thread: [
        { id: 'u1', role: 'user', content: 'Remote prompt' },
        { id: 'a1', role: 'assistant', content: 'Remote answer' },
      ],
    });

    const settings = AppSettingsSchema.parse({
      screening: { enabled: false },
      device: { id: 'dev-mine', name: 'initial-name' },
    });
    const harness = await createHarness(settings, { checkpointStore: store });

    const listed = await harness.listSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 'remote-99990000',
      isRemote: true,
      lastDeviceName: 'cloud-box',
    });

    const resumed = await harness.resumeSession('remote-9999');
    expect(resumed.isRemote).toBe(true);
    expect(resumed.summary.lastDeviceName).toBe('cloud-box');
    expect(resumed.session.messages).toHaveLength(2);
    expect(resumed.session.transcriptMessages).toHaveLength(2);

    // Save a local session on this device, then rename this device via harness.setDeviceName
    await store.save({
      sessionId: 'local-11112222',
      status: 'idle',
      kind: 'turn_end',
      device: harness.settings.device,
      transcript: [{ role: 'user', content: 'Local prompt' }],
      thread: [],
    });

    const renamedCount = await harness.setDeviceName('renamed-macbook');
    expect(renamedCount).toBe(1);
    expect(harness.settings.device.name).toBe('renamed-macbook');

    const localResumed = await harness.resumeSession('local-1111');
    expect(localResumed.isRemote).toBe(false);
    expect(localResumed.summary.originDeviceName).toBe('renamed-macbook');
    expect(localResumed.summary.lastDeviceName).toBe('renamed-macbook');

    await harness.close();
  });
});

describe('Mid-turn step checkpointing and crash recovery', () => {
  function makeTools(log: string[]) {
    const readTool = defineTool({
      name: 'read_doc',
      description: 'Read a document.',
      kind: 'read',
      schema: z.object({ topic: z.string() }),
      execute: ({ topic }) => {
        log.push(`read:${topic}`);
        return `Facts about ${topic}`;
      },
    });
    const writeTool = defineTool({
      name: 'save_note',
      description: 'Save a note.',
      kind: 'write',
      schema: z.object({ note: z.string() }),
      execute: ({ note }) => {
        log.push(`write:${note}`);
        return 'saved';
      },
    });
    return { readTool, writeTool };
  }

  test('records turn_start, step_assistant, interrupt, step_tools, and turn_end checkpoints across a multi-step turn', async () => {
    const store = new SqliteCheckpointStore(':memory:');
    const device = { id: 'dev-1', name: 'macbook' };
    const sessionId = 'step-seq-session';
    const log: string[] = [];
    const { readTool, writeTool } = makeTools(log);

    const provider = new ScriptedProvider('fake', [
      call('read_doc', { topic: 'solenoids' }, 'r1'),
      call('save_note', { note: 'electromagnetic coil' }, 'w1'),
      say('All done.'),
    ]);

    const session = new Session(
      new Agent({
        routes: [{ client: provider, model: 'm' }],
        tools: [readTool, writeTool],
      }),
      {
        threadId: sessionId,
        checkpoint: {
          save: (cp) => store.save({ ...cp, sessionId, device }),
          clear: () => store.delete(sessionId),
        },
      }
    );

    const answer = await session.send('Read and save', {
      onEvent: (e) => {
        if (e.type === EventType.RUN_FINISHED && e.outcome?.type === 'interrupt') {
          const [interrupt] = e.outcome.interrupts;
          session.resume([
            { interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } },
          ]);
        }
      },
    });

    expect(answer).toBe('All done.');
    expect(log).toEqual(['read:solenoids', 'write:electromagnetic coil']);

    const checkpoints = await store.listCheckpoints(sessionId);
    expect(checkpoints.map((c) => c.kind)).toEqual([
      'turn_start',
      'step_assistant',
      'step_tools',
      'step_assistant',
      'interrupt',
      'step_tools',
      'turn_end',
    ]);
    expect(checkpoints.every((c) => c.turnStartSeq === 1)).toBe(true);
    expect(checkpoints.at(-2)?.committed).toBe(true);
    expect(checkpoints.at(-1)?.committed).toBe(true);

    await store.close();
  });

  test('recovers from a crash at step_tools without re-running completed tools', async () => {
    const store = new SqliteCheckpointStore(':memory:');
    const device = { id: 'dev-1', name: 'macbook' };
    const sessionId = 'crash-after-tools';
    const log: string[] = [];
    const { readTool } = makeTools(log);

    // Process 1: runs step 1 (read_doc), then crashes on step 2 LLM call
    const provider1 = new ScriptedProvider('fake', [
      call('read_doc', { topic: 'valves' }, 'r1'),
      () => {
        throw new Error('simulated crash');
      },
    ]);
    const session1 = new Session(
      new Agent({ routes: [{ client: provider1, model: 'm' }], tools: [readTool] }),
      {
        threadId: sessionId,
        checkpoint: {
          save: (cp) => store.save({ ...cp, sessionId, device }),
        },
      }
    );
    await expect(session1.send('Research valves', { onEvent: () => {} })).rejects.toThrow(
      'simulated crash'
    );
    expect(log).toEqual(['read:valves']);

    // Inspect the step_tools checkpoint that was written right before the crash
    const checkpoints = await store.listCheckpoints(sessionId);
    const stepToolsCp = checkpoints.find((c) => c.kind === 'step_tools')!;
    expect(stepToolsCp).toBeDefined();

    // Process 2: restores from the step_tools checkpoint and continues the turn
    const provider2 = new ScriptedProvider('fake', [say('Valves regulate flow.')]);
    const session2 = new Session(
      new Agent({ routes: [{ client: provider2, model: 'm' }], tools: [readTool] }),
      {
        threadId: sessionId,
        initialTranscript: stepToolsCp.transcript,
        initialThread: stepToolsCp.thread,
        initialCheckpoint: {
          kind: stepToolsCp.kind,
          committed: stepToolsCp.committed,
          turnStartSeq: stepToolsCp.turnStartSeq,
        },
        checkpoint: {
          save: (cp) => store.save({ ...cp, sessionId, device }),
        },
      }
    );

    expect(session2.hasIncompleteTurn).toBe(true);
    expect(session2.incompleteTurnKind).toBe('step_tools');

    const finalOutput = await session2.continueTurn({ onEvent: () => {} });
    expect(finalOutput).toBe('Valves regulate flow.');
    // read_doc was NOT executed a second time
    expect(log).toEqual(['read:valves']);
    expect(session2.hasIncompleteTurn).toBe(false);

    await store.close();
  });

  test('recovers from a crash while paused on an approval interrupt, preserving completed reads in the same turn', async () => {
    const store = new SqliteCheckpointStore(':memory:');
    const device = { id: 'dev-1', name: 'macbook' };
    const sessionId = 'crash-at-interrupt';
    const log: string[] = [];
    const { readTool, writeTool } = makeTools(log);

    // Process 1: model requests BOTH read_doc and save_note in the same assistant turn
    const provider1 = new ScriptedProvider('fake', [
      {
        role: 'assistant',
        content: 'Reading and saving.',
        toolCalls: [
          { id: 'r1', name: 'read_doc', arguments: { topic: 'coil' } },
          { id: 'w1', name: 'save_note', arguments: { note: 'coil summary' } },
        ],
      },
    ]);

    let interruptCheckpointSaved = false;
    const session1 = new Session(
      new Agent({ routes: [{ client: provider1, model: 'm' }], tools: [readTool, writeTool] }),
      {
        threadId: sessionId,
        checkpoint: {
          save: async (cp) => {
            const meta = await store.save({ ...cp, sessionId, device });
            if (cp.kind === 'interrupt') interruptCheckpointSaved = true;
            return meta;
          },
        },
      }
    );

    // Start the turn, wait until it pauses on the approval interrupt, then simulate a process crash
    const { promise: paused, resolve: onPaused } = Promise.withResolvers<void>();
    void session1.send('Read coil and save', {
      onEvent: (e) => {
        if (e.type === EventType.RUN_FINISHED && e.outcome?.type === 'interrupt') {
          onPaused();
        }
      },
    });
    await paused;

    expect(interruptCheckpointSaved).toBe(true);
    // read_doc already ran before the approval interrupt paused save_note
    expect(log).toEqual(['read:coil']);

    // Process 2: load latest checkpoint (which is the `interrupt` checkpoint!)
    const loaded = await store.load(sessionId);
    expect(loaded?.session.status).toBe('waiting_approval');
    expect(loaded?.checkpoint.kind).toBe('interrupt');

    const provider2 = new ScriptedProvider('fake', [say('Saved after crash recovery.')]);
    const session2 = new Session(
      new Agent({ routes: [{ client: provider2, model: 'm' }], tools: [readTool, writeTool] }),
      {
        threadId: loaded!.session.id,
        initialTranscript: loaded!.checkpoint.transcript,
        initialThread: loaded!.checkpoint.thread,
        initialCheckpoint: {
          kind: loaded!.checkpoint.kind,
          committed: loaded!.checkpoint.committed,
          turnStartSeq: loaded!.checkpoint.turnStartSeq,
        },
        checkpoint: {
          save: (cp) => store.save({ ...cp, sessionId, device }),
        },
      }
    );

    expect(session2.hasIncompleteTurn).toBe(true);
    expect(session2.incompleteTurnKind).toBe('interrupt');

    // Continuing re-emits the approval interrupt for w1 WITHOUT re-running r1
    const result = await session2.continueTurn({
      onEvent: (e) => {
        if (e.type === EventType.RUN_FINISHED && e.outcome?.type === 'interrupt') {
          const [interrupt] = e.outcome.interrupts;
          expect(interrupt?.reason).toBe(APPROVAL_REASON);
          expect(interrupt?.toolCallId).toBe('w1');
          session2.resume([
            { interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } },
          ]);
        }
      },
    });

    expect(result).toBe('Saved after crash recovery.');
    // r1 ran once (in Process 1), w1 ran once (in Process 2 after approval)
    expect(log).toEqual(['read:coil', 'write:coil summary']);
    // No duplicate tool calls in the AG-UI thread
    const assistantMsg = session2.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.role === 'assistant' && assistantMsg.toolCalls?.map((c) => c.id)).toEqual([
      'r1',
      'w1',
    ]);

    await store.close();
  });

  test('recovers from a crash at step_assistant by re-running reads and refusing in-flight writes safely', async () => {
    const store = new SqliteCheckpointStore(':memory:');
    const device = { id: 'dev-1', name: 'macbook' };
    const sessionId = 'crash-in-flight-write';
    const log: string[] = [];
    const { readTool, writeTool } = makeTools(log);

    // Simulate a checkpoint left at `step_assistant` where the process died while
    // tools [read_doc, save_note] were in-flight
    await store.save({
      sessionId,
      status: 'running',
      kind: 'step_assistant',
      device,
      transcript: [
        { role: 'user', content: 'Read and write', origin: 'operator', screened: true },
        {
          role: 'assistant',
          content: '',
          screened: true,
          toolCalls: [
            { id: 'r1', name: 'read_doc', arguments: { topic: 'physics' } },
            { id: 'w1', name: 'save_note', arguments: { note: 'unsafe repeat' } },
          ],
          raw: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'r1',
                type: 'function',
                function: { name: 'read_doc', arguments: '{"topic":"physics"}' },
              },
              {
                id: 'w1',
                type: 'function',
                function: { name: 'save_note', arguments: '{"note":"unsafe repeat"}' },
              },
            ],
          },
        },
      ],
      thread: [
        { id: 'u1', role: 'user', content: 'Read and write' },
        { id: 'a1', role: 'assistant', content: '' },
      ],
    });

    const loaded = await store.load(sessionId);
    const provider = new ScriptedProvider('fake', [
      say('I read the physics doc; the write was interrupted by a crash so I did not repeat it.'),
    ]);
    const session = new Session(
      new Agent({ routes: [{ client: provider, model: 'm' }], tools: [readTool, writeTool] }),
      {
        threadId: sessionId,
        initialTranscript: loaded!.checkpoint.transcript,
        initialThread: loaded!.checkpoint.thread,
        initialCheckpoint: {
          kind: loaded!.checkpoint.kind,
          committed: loaded!.checkpoint.committed,
          turnStartSeq: loaded!.checkpoint.turnStartSeq,
        },
        approve: () => ({ allow: true }),
        checkpoint: {
          save: (cp) => store.save({ ...cp, sessionId, device }),
        },
      }
    );

    const output = await session.continueTurn({ onEvent: () => {} });
    expect(output).toContain('write was interrupted');
    // read_doc ran, save_note was NOT blindly re-run
    expect(log).toEqual(['read:physics']);
    const writeToolMsg = provider.calls[0]?.find((m) => m.role === 'tool' && m.toolCallId === 'w1');
    expect(writeToolMsg?.content).toContain('Process terminated while this write tool was running');

    await store.close();
  });
});
