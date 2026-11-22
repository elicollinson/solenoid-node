/**
 * Session Checkpoints
 *
 * Durable storage for conversation sessions and turn/step checkpoints so a
 * session can be resumed after an exit, a crash, or across machines.
 *
 * - Default local store: `SqliteCheckpointStore` (built on `bun:sqlite` in WAL
 *   mode at `~/.solenoid/checkpoints.db`).
 * - Optional remote store: `SupabaseCheckpointStore` (PostgREST connector to a
 *   Supabase Postgres project).
 * - When both are active, `CompositeCheckpointStore` writes locally first and
 *   mirrors to Supabase, and merges remote sessions on load/list so a run from
 *   another device can be resumed locally with its origin/last device shown.
 *
 * Each session and checkpoint stamps both `deviceId` (immutable per machine)
 * and `deviceName` (editable via `/device-name <name>`). Renaming a device
 * updates its historical records in place across both `sessions` and
 * `checkpoints`.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Message } from '@ag-ui/core';
import {
  type AppSettings,
  type DeviceConfig,
  type SupabaseCredentials,
  getSqliteCheckpointPath,
  getSupabaseCheckpointConfig,
} from '../config/index.js';
import { type ChatMessage, truncate } from '../core/index.js';
import { agentLogger } from '../utils/logger.js';

export type SessionStatus = 'idle' | 'running' | 'waiting_approval' | 'failed' | 'closed';

/**
 * Granularity of a saved checkpoint:
 * - Phase 1 (between-turn): `turn_start`, `turn_end`
 * - Phase 2 (mid-turn): `step_assistant`, `step_tools`, `interrupt`
 */
export type CheckpointKind =
  | 'turn_start'
  | 'step_assistant'
  | 'step_tools'
  | 'interrupt'
  | 'turn_end';

export interface SessionSummary {
  id: string;
  parentId?: string;
  title: string;
  status: SessionStatus;
  originDeviceId: string;
  originDeviceName: string;
  lastDeviceId: string;
  lastDeviceName: string;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointRecord {
  sessionId: string;
  seq: number;
  kind: CheckpointKind;
  deviceId: string;
  deviceName: string;
  committed: boolean;
  turnStartSeq: number;
  transcript: ChatMessage[];
  thread: Message[];
  pending?: Record<string, unknown>;
  createdAt: string;
}

export interface SaveCheckpointInput {
  sessionId: string;
  parentId?: string;
  title?: string;
  status: SessionStatus;
  kind: CheckpointKind;
  device: DeviceConfig;
  committed?: boolean;
  /**
   * The sequence number of the checkpoint that opened the current turn.
   * When omitted on `turn_start`, the new checkpoint's own `seq` is used.
   */
  turnStartSeq?: number;
  transcript: readonly ChatMessage[];
  thread: readonly Message[];
  pending?: Record<string, unknown>;
}

export interface SavedCheckpointMeta {
  seq: number;
  turnStartSeq: number;
}

export interface LoadedSession {
  session: SessionSummary;
  checkpoint: CheckpointRecord;
}

export interface CheckpointStore {
  /** Save a checkpoint snapshot and upsert its session summary. */
  save(input: SaveCheckpointInput): Promise<SavedCheckpointMeta>;
  /**
   * Load a session and its latest checkpoint by exact ID or unambiguous prefix.
   * Returns undefined when no session matches.
   */
  load(sessionIdOrPrefix: string): Promise<LoadedSession | undefined>;
  /** Load the most recently updated top-level session, if any. */
  loadLatest(): Promise<LoadedSession | undefined>;
  /** List top-level sessions, ordered by most recently updated first. */
  list(limit?: number): Promise<SessionSummary[]>;
  /** List all saved checkpoints for a session in sequence order (`seq ASC`). */
  listCheckpoints(sessionId: string): Promise<CheckpointRecord[]>;
  /**
   * Backfill `newName` across all historical sessions and checkpoints created
   * or updated by `deviceId` (or matching `oldName`). Returns the number of
   * sessions updated.
   */
  renameDevice(deviceId: string, newName: string, oldName?: string): Promise<number>;
  /** Remove a session and all of its checkpoints. */
  delete(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

const TITLE_MAX_CHARS = 72;

/** Derive a concise one-line session title from the first user message. */
export function deriveSessionTitle(
  transcript: readonly ChatMessage[],
  fallback = 'Untitled session'
): string {
  const firstUser = transcript.find((m) => m.role === 'user' && m.content.trim().length > 0);
  if (!firstUser) return fallback;
  const oneLine = firstUser.content.replace(/\s+/g, ' ').trim();
  return truncate(oneLine, TITLE_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// SQLite implementation (local default)
// ---------------------------------------------------------------------------

interface SqliteSessionRow {
  id: string;
  parent_id: string | null;
  title: string;
  status: SessionStatus;
  origin_device_id: string;
  origin_device_name: string;
  last_device_id: string;
  last_device_name: string;
  last_seq: number;
  created_at: string;
  updated_at: string;
}

interface SqliteCheckpointRow {
  session_id: string;
  seq: number;
  kind: CheckpointKind;
  device_id: string;
  device_name: string;
  committed: number;
  turn_start_seq: number;
  transcript: string;
  thread: string;
  pending: string | null;
  created_at: string;
}

function rowToSessionSummary(row: SqliteSessionRow): SessionSummary {
  return {
    id: row.id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    title: row.title,
    status: row.status,
    originDeviceId: row.origin_device_id,
    originDeviceName: row.origin_device_name,
    lastDeviceId: row.last_device_id,
    lastDeviceName: row.last_device_name,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCheckpointRecord(row: SqliteCheckpointRow): CheckpointRecord {
  return {
    sessionId: row.session_id,
    seq: row.seq,
    kind: row.kind,
    deviceId: row.device_id,
    deviceName: row.device_name,
    committed: Boolean(row.committed),
    turnStartSeq: row.turn_start_seq,
    transcript: JSON.parse(row.transcript) as ChatMessage[],
    thread: JSON.parse(row.thread) as Message[],
    ...(row.pending ? { pending: JSON.parse(row.pending) as Record<string, unknown> } : {}),
    createdAt: row.created_at,
  };
}

export class SqliteCheckpointStore implements CheckpointStore {
  private readonly db: Database;
  private closed = false;

  constructor(readonly filePath: string = ':memory:') {
    if (filePath !== ':memory:') {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(filePath, { create: true });
    this.initSchema();
  }

  private initSchema(): void {
    this.db.run('PRAGMA journal_mode = WAL;');
    this.db.run('PRAGMA synchronous = NORMAL;');
    this.db.run('PRAGMA foreign_keys = ON;');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        origin_device_id TEXT NOT NULL,
        origin_device_name TEXT NOT NULL,
        last_device_id TEXT NOT NULL,
        last_device_name TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_updated
      ON sessions (parent_id, updated_at DESC);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_origin_device
      ON sessions (origin_device_id);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_last_device
      ON sessions (last_device_id);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        committed INTEGER NOT NULL DEFAULT 0,
        turn_start_seq INTEGER NOT NULL,
        transcript TEXT NOT NULL,
        thread TEXT NOT NULL,
        pending TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_device
      ON checkpoints (device_id);
    `);
  }

  save(input: SaveCheckpointInput): Promise<SavedCheckpointMeta> {
    return Promise.resolve(this.saveSync(input));
  }

  saveSync(input: SaveCheckpointInput): SavedCheckpointMeta {
    const now = new Date().toISOString();
    const tx = this.db.transaction((): SavedCheckpointMeta => {
      const existing = this.db
        .query<{ last_seq: number; title: string }, [string]>(
          'SELECT last_seq, title FROM sessions WHERE id = ?1'
        )
        .get(input.sessionId);

      const seq = (existing?.last_seq ?? 0) + 1;
      const turnStartSeq = input.turnStartSeq ?? seq;
      const title =
        input.title ??
        (existing?.title && existing.title !== 'Untitled session'
          ? existing.title
          : deriveSessionTitle(input.transcript));

      this.db
        .query(
          `INSERT INTO sessions (
            id, parent_id, title, status,
            origin_device_id, origin_device_name,
            last_device_id, last_device_name,
            last_seq, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            status = excluded.status,
            last_device_id = excluded.last_device_id,
            last_device_name = excluded.last_device_name,
            last_seq = excluded.last_seq,
            updated_at = excluded.updated_at`
        )
        .run(
          input.sessionId,
          input.parentId ?? null,
          title,
          input.status,
          input.device.id,
          input.device.name,
          input.device.id,
          input.device.name,
          seq,
          now,
          now
        );

      this.db
        .query(
          `INSERT INTO checkpoints (
            session_id, seq, kind,
            device_id, device_name,
            committed, turn_start_seq,
            transcript, thread, pending, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
        )
        .run(
          input.sessionId,
          seq,
          input.kind,
          input.device.id,
          input.device.name,
          input.committed ? 1 : 0,
          turnStartSeq,
          JSON.stringify(input.transcript),
          JSON.stringify(input.thread),
          input.pending ? JSON.stringify(input.pending) : null,
          now
        );

      return { seq, turnStartSeq };
    });

    return tx();
  }

  /**
   * Cache a remote session and checkpoint locally so a remote session can be
   * inspected and continued even if connectivity drops later.
   */
  cacheLoadedSessionSync(loaded: LoadedSession): void {
    const { session: s, checkpoint: c } = loaded;
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO sessions (
            id, parent_id, title, status,
            origin_device_id, origin_device_name,
            last_device_id, last_device_name,
            last_seq, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            status = excluded.status,
            origin_device_id = excluded.origin_device_id,
            origin_device_name = excluded.origin_device_name,
            last_device_id = excluded.last_device_id,
            last_device_name = excluded.last_device_name,
            last_seq = MAX(sessions.last_seq, excluded.last_seq),
            updated_at = excluded.updated_at`
        )
        .run(
          s.id,
          s.parentId ?? null,
          s.title,
          s.status,
          s.originDeviceId,
          s.originDeviceName,
          s.lastDeviceId,
          s.lastDeviceName,
          s.lastSeq,
          s.createdAt,
          s.updatedAt
        );

      this.db
        .query(
          `INSERT OR REPLACE INTO checkpoints (
            session_id, seq, kind,
            device_id, device_name,
            committed, turn_start_seq,
            transcript, thread, pending, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
        )
        .run(
          c.sessionId,
          c.seq,
          c.kind,
          c.deviceId,
          c.deviceName,
          c.committed ? 1 : 0,
          c.turnStartSeq,
          JSON.stringify(c.transcript),
          JSON.stringify(c.thread),
          c.pending ? JSON.stringify(c.pending) : null,
          c.createdAt
        );
    });
    tx();
  }

  load(sessionIdOrPrefix: string): Promise<LoadedSession | undefined> {
    const key = sessionIdOrPrefix.trim();
    if (!key) return Promise.resolve(undefined);

    let sessionRow = this.db
      .query<SqliteSessionRow, [string]>('SELECT * FROM sessions WHERE id = ?1')
      .get(key);

    if (!sessionRow) {
      const matches = this.db
        .query<SqliteSessionRow, [string]>(
          'SELECT * FROM sessions WHERE id LIKE ?1 ORDER BY updated_at DESC LIMIT 2'
        )
        .all(`${key}%`);
      if (matches.length > 1) {
        return Promise.reject(
          new Error(
            `Session prefix "${key}" is ambiguous (${matches.map((m) => m.id.slice(0, 8)).join(', ')})`
          )
        );
      }
      sessionRow = matches[0] ?? null;
    }

    if (!sessionRow) return Promise.resolve(undefined);
    return Promise.resolve(this.loadCheckpointForRow(sessionRow));
  }

  loadLatest(): Promise<LoadedSession | undefined> {
    const row = this.db
      .query<SqliteSessionRow, []>(
        'SELECT * FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1'
      )
      .get();
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve(this.loadCheckpointForRow(row));
  }

  private loadCheckpointForRow(sessionRow: SqliteSessionRow): LoadedSession | undefined {
    const cpRow = this.db
      .query<SqliteCheckpointRow, [string]>(
        'SELECT * FROM checkpoints WHERE session_id = ?1 ORDER BY seq DESC LIMIT 1'
      )
      .get(sessionRow.id);
    if (!cpRow) return undefined;
    return {
      session: rowToSessionSummary(sessionRow),
      checkpoint: rowToCheckpointRecord(cpRow),
    };
  }

  list(limit = 20): Promise<SessionSummary[]> {
    const rows = this.db
      .query<SqliteSessionRow, [number]>(
        'SELECT * FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT ?1'
      )
      .all(limit);
    return Promise.resolve(rows.map(rowToSessionSummary));
  }

  listCheckpoints(sessionId: string): Promise<CheckpointRecord[]> {
    const rows = this.db
      .query<SqliteCheckpointRow, [string]>(
        'SELECT * FROM checkpoints WHERE session_id = ?1 ORDER BY seq ASC'
      )
      .all(sessionId);
    return Promise.resolve(rows.map(rowToCheckpointRecord));
  }

  renameDevice(deviceId: string, newName: string, oldName?: string): Promise<number> {
    const trimmed = newName.trim();
    const prev = oldName?.trim() || null;
    const tx = this.db.transaction((): number => {
      const affected = this.db
        .query<{ count: number }, [string, string | null]>(
          `SELECT COUNT(*) as count FROM sessions
           WHERE origin_device_id = ?1
              OR last_device_id = ?1
              OR (?2 IS NOT NULL AND (origin_device_name = ?2 OR last_device_name = ?2))`
        )
        .get(deviceId, prev);

      this.db
        .query(
          `UPDATE sessions
           SET origin_device_name = ?1
           WHERE origin_device_id = ?2
              OR (?3 IS NOT NULL AND origin_device_name = ?3)`
        )
        .run(trimmed, deviceId, prev);

      this.db
        .query(
          `UPDATE sessions
           SET last_device_name = ?1
           WHERE last_device_id = ?2
              OR (?3 IS NOT NULL AND last_device_name = ?3)`
        )
        .run(trimmed, deviceId, prev);

      this.db
        .query(
          `UPDATE checkpoints
           SET device_name = ?1
           WHERE device_id = ?2
              OR (?3 IS NOT NULL AND device_name = ?3)`
        )
        .run(trimmed, deviceId, prev);

      return affected?.count ?? 0;
    });
    return Promise.resolve(tx());
  }

  delete(sessionId: string): Promise<void> {
    this.db.query('DELETE FROM sessions WHERE id = ?1').run(sessionId);
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Supabase implementation (optional remote PostgREST connector)
// ---------------------------------------------------------------------------

/**
 * Postgres DDL for the Supabase tables and indexes, following Supabase Postgres
 * best practices (`jsonb`, `timestamptz`, composite PK, FK indexes, and RLS).
 */
export function supabaseSchemaSql(tablePrefix = 'solenoid_'): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tablePrefix)) {
    throw new Error(`Invalid table prefix: ${tablePrefix}`);
  }
  const sessions = `${tablePrefix}sessions`;
  const checkpoints = `${tablePrefix}checkpoints`;
  return `
create table if not exists public.${sessions} (
  id text primary key,
  parent_id text references public.${sessions}(id) on delete cascade,
  title text not null,
  status text not null,
  origin_device_id text not null,
  origin_device_name text not null,
  last_device_id text not null,
  last_device_name text not null,
  last_seq integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_${sessions}_parent_updated
  on public.${sessions} (parent_id, updated_at desc);
create index if not exists idx_${sessions}_origin_device
  on public.${sessions} (origin_device_id);
create index if not exists idx_${sessions}_last_device
  on public.${sessions} (last_device_id);

create table if not exists public.${checkpoints} (
  session_id text not null references public.${sessions}(id) on delete cascade,
  seq integer not null,
  kind text not null,
  device_id text not null,
  device_name text not null,
  committed boolean not null default false,
  turn_start_seq integer not null,
  transcript jsonb not null,
  thread jsonb not null,
  pending jsonb,
  created_at timestamptz not null default now(),
  primary key (session_id, seq)
);

create index if not exists idx_${checkpoints}_device
  on public.${checkpoints} (device_id);

alter table public.${sessions} enable row level security;
alter table public.${checkpoints} enable row level security;
`.trim();
}

interface SupabaseSessionRow {
  id: string;
  parent_id: string | null;
  title: string;
  status: SessionStatus;
  origin_device_id: string;
  origin_device_name: string;
  last_device_id: string;
  last_device_name: string;
  last_seq: number;
  created_at: string;
  updated_at: string;
}

interface SupabaseCheckpointRow {
  session_id: string;
  seq: number;
  kind: CheckpointKind;
  device_id: string;
  device_name: string;
  committed: boolean;
  turn_start_seq: number;
  transcript: ChatMessage[];
  thread: Message[];
  pending: Record<string, unknown> | null;
  created_at: string;
}

function supabaseRowToCheckpoint(row: SupabaseCheckpointRow): CheckpointRecord {
  return {
    sessionId: row.session_id,
    seq: row.seq,
    kind: row.kind,
    deviceId: row.device_id,
    deviceName: row.device_name,
    committed: Boolean(row.committed),
    turnStartSeq: row.turn_start_seq,
    transcript: Array.isArray(row.transcript)
      ? row.transcript
      : (JSON.parse(String(row.transcript)) as ChatMessage[]),
    thread: Array.isArray(row.thread) ? row.thread : (JSON.parse(String(row.thread)) as Message[]),
    ...(row.pending ? { pending: row.pending } : {}),
    createdAt: row.created_at,
  };
}

function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

export class SupabaseCheckpointStore implements CheckpointStore {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly sessionsTable: string;
  private readonly checkpointsTable: string;
  private readonly fetchFn: typeof fetch;

  constructor(credentials: SupabaseCredentials, options: { fetchFn?: typeof fetch } = {}) {
    this.baseUrl = trimTrailingSlashes(credentials.url);
    this.apiKey = credentials.apiKey;
    const prefix = credentials.tablePrefix ?? 'solenoid_';
    this.sessionsTable = `${prefix}sessions`;
    this.checkpointsTable = `${prefix}checkpoints`;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private async request<T>(table: string, query: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`;
    const response = await this.fetchFn(url, {
      ...init,
      headers: this.headers(init.headers as Record<string, string> | undefined),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Supabase ${init.method ?? 'GET'} ${table} failed (${response.status}): ${body}`
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Persist a checkpoint with an explicit `seq` and `turnStartSeq` (used by
   * `CompositeCheckpointStore` to mirror the local SQLite sequence) or compute
   * the next sequence from the remote session.
   */
  async saveWithMeta(
    input: SaveCheckpointInput,
    meta?: SavedCheckpointMeta
  ): Promise<SavedCheckpointMeta> {
    const now = new Date().toISOString();
    const existingRows = await this.request<SupabaseSessionRow[]>(
      this.sessionsTable,
      `id=eq.${encodeURIComponent(input.sessionId)}&select=*`
    );
    const existing = existingRows?.[0];
    const seq = meta?.seq ?? (existing?.last_seq ?? 0) + 1;
    const turnStartSeq = meta?.turnStartSeq ?? input.turnStartSeq ?? seq;
    const title =
      input.title ??
      (existing?.title && existing.title !== 'Untitled session'
        ? existing.title
        : deriveSessionTitle(input.transcript));

    const sessionRow: SupabaseSessionRow = {
      id: input.sessionId,
      parent_id: input.parentId ?? existing?.parent_id ?? null,
      title,
      status: input.status,
      origin_device_id: existing?.origin_device_id ?? input.device.id,
      origin_device_name: existing?.origin_device_name ?? input.device.name,
      last_device_id: input.device.id,
      last_device_name: input.device.name,
      last_seq: Math.max(existing?.last_seq ?? 0, seq),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    await this.request(this.sessionsTable, 'on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(sessionRow),
    });

    const checkpointRow: SupabaseCheckpointRow = {
      session_id: input.sessionId,
      seq,
      kind: input.kind,
      device_id: input.device.id,
      device_name: input.device.name,
      committed: Boolean(input.committed),
      turn_start_seq: turnStartSeq,
      transcript: [...input.transcript],
      thread: [...input.thread],
      pending: input.pending ?? null,
      created_at: now,
    };

    await this.request(this.checkpointsTable, 'on_conflict=session_id,seq', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(checkpointRow),
    });

    return { seq, turnStartSeq };
  }

  save(input: SaveCheckpointInput): Promise<SavedCheckpointMeta> {
    return this.saveWithMeta(input);
  }

  async load(sessionIdOrPrefix: string): Promise<LoadedSession | undefined> {
    const key = sessionIdOrPrefix.trim();
    if (!key) return undefined;

    let rows = await this.request<SupabaseSessionRow[]>(
      this.sessionsTable,
      `id=eq.${encodeURIComponent(key)}&select=*`
    );

    if (!rows?.length) {
      rows = await this.request<SupabaseSessionRow[]>(
        this.sessionsTable,
        `id=like.${encodeURIComponent(`${key}*`)}&order=updated_at.desc&limit=2&select=*`
      );
      if (rows && rows.length > 1) {
        throw new Error(
          `Session prefix "${key}" is ambiguous (${rows.map((m) => m.id.slice(0, 8)).join(', ')})`
        );
      }
    }

    const sessionRow = rows?.[0];
    if (!sessionRow) return undefined;
    return this.loadCheckpointForSession(sessionRow);
  }

  async loadLatest(): Promise<LoadedSession | undefined> {
    const rows = await this.request<SupabaseSessionRow[]>(
      this.sessionsTable,
      'parent_id=is.null&order=updated_at.desc&limit=1&select=*'
    );
    const sessionRow = rows?.[0];
    if (!sessionRow) return undefined;
    return this.loadCheckpointForSession(sessionRow);
  }

  private async loadCheckpointForSession(
    sessionRow: SupabaseSessionRow
  ): Promise<LoadedSession | undefined> {
    const cpRows = await this.request<SupabaseCheckpointRow[]>(
      this.checkpointsTable,
      `session_id=eq.${encodeURIComponent(sessionRow.id)}&order=seq.desc&limit=1&select=*`
    );
    const cpRow = cpRows?.[0];
    if (!cpRow) return undefined;
    return {
      session: rowToSessionSummary(sessionRow),
      checkpoint: supabaseRowToCheckpoint(cpRow),
    };
  }

  async list(limit = 20): Promise<SessionSummary[]> {
    const rows = await this.request<SupabaseSessionRow[]>(
      this.sessionsTable,
      `parent_id=is.null&order=updated_at.desc&limit=${limit}&select=*`
    );
    return (rows ?? []).map(rowToSessionSummary);
  }

  async listCheckpoints(sessionId: string): Promise<CheckpointRecord[]> {
    const rows = await this.request<SupabaseCheckpointRow[]>(
      this.checkpointsTable,
      `session_id=eq.${encodeURIComponent(sessionId)}&order=seq.asc&select=*`
    );
    return (rows ?? []).map(supabaseRowToCheckpoint);
  }

  async renameDevice(deviceId: string, newName: string, oldName?: string): Promise<number> {
    const trimmed = newName.trim();
    const prev = oldName?.trim();
    const originFilter = prev
      ? `or=(origin_device_id.eq.${encodeURIComponent(deviceId)},origin_device_name.eq.${encodeURIComponent(prev)})`
      : `origin_device_id=eq.${encodeURIComponent(deviceId)}`;
    const lastFilter = prev
      ? `or=(last_device_id.eq.${encodeURIComponent(deviceId)},last_device_name.eq.${encodeURIComponent(prev)})`
      : `last_device_id=eq.${encodeURIComponent(deviceId)}`;
    const cpFilter = prev
      ? `or=(device_id.eq.${encodeURIComponent(deviceId)},device_name.eq.${encodeURIComponent(prev)})`
      : `device_id=eq.${encodeURIComponent(deviceId)}`;

    const updatedOrigin = await this.request<SupabaseSessionRow[]>(
      this.sessionsTable,
      `${originFilter}&select=id`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ origin_device_name: trimmed }),
      }
    );

    const updatedLast = await this.request<SupabaseSessionRow[]>(
      this.sessionsTable,
      `${lastFilter}&select=id`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ last_device_name: trimmed }),
      }
    );

    await this.request(this.checkpointsTable, cpFilter, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ device_name: trimmed }),
    });

    const ids = new Set<string>([
      ...(updatedOrigin ?? []).map((r) => r.id),
      ...(updatedLast ?? []).map((r) => r.id),
    ]);
    return ids.size;
  }

  async delete(sessionId: string): Promise<void> {
    await this.request(this.sessionsTable, `id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Composite store (Local SQLite primary + Remote Supabase mirror)
// ---------------------------------------------------------------------------

export class CompositeCheckpointStore implements CheckpointStore {
  constructor(
    readonly local: SqliteCheckpointStore,
    readonly remote: SupabaseCheckpointStore
  ) {}

  async save(input: SaveCheckpointInput): Promise<SavedCheckpointMeta> {
    const meta = await this.local.save(input);
    try {
      await this.remote.saveWithMeta(input, meta);
    } catch (error) {
      agentLogger.warn(
        { error: String(error), sessionId: input.sessionId, seq: meta.seq },
        '[checkpoints] remote Supabase save failed; local SQLite checkpoint succeeded'
      );
    }
    return meta;
  }

  async load(sessionIdOrPrefix: string): Promise<LoadedSession | undefined> {
    const [localLoaded, remoteLoaded] = await Promise.all([
      this.local.load(sessionIdOrPrefix),
      this.remote.load(sessionIdOrPrefix).catch((error) => {
        agentLogger.warn(
          { error: String(error), sessionIdOrPrefix },
          '[checkpoints] remote Supabase load failed; using local SQLite'
        );
        return undefined;
      }),
    ]);

    if (
      remoteLoaded &&
      (!localLoaded || remoteLoaded.checkpoint.seq >= localLoaded.checkpoint.seq)
    ) {
      this.local.cacheLoadedSessionSync(remoteLoaded);
      return remoteLoaded;
    }
    return localLoaded;
  }

  async loadLatest(): Promise<LoadedSession | undefined> {
    const [localLoaded, remoteLoaded] = await Promise.all([
      this.local.loadLatest(),
      this.remote.loadLatest().catch((error) => {
        agentLogger.warn(
          { error: String(error) },
          '[checkpoints] remote Supabase loadLatest failed; using local SQLite'
        );
        return undefined;
      }),
    ]);

    if (
      remoteLoaded &&
      (!localLoaded || remoteLoaded.session.updatedAt >= localLoaded.session.updatedAt)
    ) {
      this.local.cacheLoadedSessionSync(remoteLoaded);
      return remoteLoaded;
    }
    return localLoaded;
  }

  async list(limit = 20): Promise<SessionSummary[]> {
    const [localList, remoteList] = await Promise.all([
      this.local.list(limit),
      this.remote.list(limit).catch((error) => {
        agentLogger.warn(
          { error: String(error) },
          '[checkpoints] remote Supabase list failed; using local SQLite'
        );
        return [] as SessionSummary[];
      }),
    ]);

    const merged = new Map<string, SessionSummary>();
    for (const item of localList) merged.set(item.id, item);
    for (const item of remoteList) {
      const existing = merged.get(item.id);
      if (!existing || item.lastSeq > existing.lastSeq || item.updatedAt > existing.updatedAt) {
        merged.set(item.id, item);
      }
    }

    return [...merged.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async listCheckpoints(sessionId: string): Promise<CheckpointRecord[]> {
    const localCheckpoints = await this.local.listCheckpoints(sessionId);
    if (localCheckpoints.length) return localCheckpoints;
    try {
      return await this.remote.listCheckpoints(sessionId);
    } catch {
      return [];
    }
  }

  async renameDevice(deviceId: string, newName: string, oldName?: string): Promise<number> {
    const localCount = await this.local.renameDevice(deviceId, newName, oldName);
    let remoteCount = 0;
    try {
      remoteCount = await this.remote.renameDevice(deviceId, newName, oldName);
    } catch (error) {
      agentLogger.warn(
        { error: String(error), deviceId, newName },
        '[checkpoints] remote Supabase device rename failed; local SQLite updated'
      );
    }
    return Math.max(localCount, remoteCount);
  }

  async delete(sessionId: string): Promise<void> {
    await this.local.delete(sessionId);
    try {
      await this.remote.delete(sessionId);
    } catch (error) {
      agentLogger.warn(
        { error: String(error), sessionId },
        '[checkpoints] remote Supabase delete failed; local SQLite deleted'
      );
    }
  }

  async close(): Promise<void> {
    await this.local.close();
    await this.remote.close();
  }
}

/**
 * Create the configured checkpoint store from settings, or undefined when
 * `checkpoints.enabled` is false.
 */
export function createCheckpointStore(
  settings: AppSettings,
  options: { sqlitePath?: string; fetchFn?: typeof fetch } = {}
): CheckpointStore | undefined {
  if (!settings.checkpoints.enabled) return undefined;
  const sqlitePath = options.sqlitePath ?? getSqliteCheckpointPath(settings);
  let local: SqliteCheckpointStore;
  try {
    local = new SqliteCheckpointStore(sqlitePath);
  } catch (error) {
    agentLogger.warn(
      { error: String(error), sqlitePath },
      '[checkpoints] could not open SQLite file; falling back to in-memory store'
    );
    local = new SqliteCheckpointStore(':memory:');
  }
  const supabaseConfig = getSupabaseCheckpointConfig(settings);
  if (!supabaseConfig) return local;
  const remote = new SupabaseCheckpointStore(supabaseConfig, { fetchFn: options.fetchFn });
  return new CompositeCheckpointStore(local, remote);
}
