// SQLite index for iter2. Source of truth is the JSONL wire log at
// .c1/runs/<run_id>/traffic.jsonl (§15) — this file is the queryable
// aggregate. Write order: JSONL fsync → SQLite commit.
//
// Uses node:sqlite (Node 22+ stable, 25 unwarned). Kept sync — SQLite
// transactions are fast; async wrappers would add nothing for the write
// volume canaryone produces.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

export type RunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'aborted';
export type SessionStatus = 'queued' | 'running' | 'complete' | 'failed' | 'aborted';

export interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  target_dir: string;
  meta_json: string;
}

export interface SessionRow {
  id: string;
  run_id: string;
  task_id: string;
  task_file: string;
  model_slug: string;
  destination_slug: string;
  router: string;
  repeat_ix: number;
  status: SessionStatus;
  started_at: string;
  finished_at: string | null;
  cost_usd: number;
  verify_exit_code: number | null;
  verify_stdout_tail: string | null;
  verify_stderr_tail: string | null;
  failure_class: string | null;
  worktree_path: string | null;
  proxy_port: number | null;
}

export interface StepRow {
  id: string;
  session_id: string;
  step_ix: number;
  started_at: string;
  finished_at: string | null;
  http_status: number | null;
  inbound_shape: 'openai' | 'anthropic';
  path: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  translation_notes: string | null;
  traffic_log_offset: number | null;
  traffic_log_length: number | null;
  failure_class: string | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  target_dir   TEXT NOT NULL,
  meta_json    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id),
  task_id            TEXT NOT NULL,
  task_file          TEXT NOT NULL,
  model_slug         TEXT NOT NULL,
  destination_slug   TEXT NOT NULL,
  router             TEXT NOT NULL,
  repeat_ix          INTEGER NOT NULL,
  status             TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  cost_usd           REAL NOT NULL DEFAULT 0,
  verify_exit_code   INTEGER,
  verify_stdout_tail TEXT,
  verify_stderr_tail TEXT,
  failure_class      TEXT,
  worktree_path      TEXT,
  proxy_port         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_run_id ON sessions(run_id);

CREATE TABLE IF NOT EXISTS steps (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id),
  step_ix              INTEGER NOT NULL,
  started_at           TEXT NOT NULL,
  finished_at          TEXT,
  http_status          INTEGER,
  inbound_shape        TEXT NOT NULL,
  path                 TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL NOT NULL DEFAULT 0,
  latency_ms           INTEGER,
  translation_notes    TEXT,
  traffic_log_offset   INTEGER,
  traffic_log_length   INTEGER,
  failure_class        TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_session_id ON steps(session_id);

CREATE TABLE IF NOT EXISTS tasks_meta (
  task_id    TEXT PRIMARY KEY,
  file       TEXT NOT NULL,
  summary    TEXT,
  uses_llm   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS classifier_tags (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  dimension     TEXT NOT NULL,
  value         TEXT NOT NULL,
  confidence    REAL,
  generated_at  TEXT NOT NULL,
  model         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_classifier_tags_session_id ON classifier_tags(session_id);
`;

export class Db {
  private db: DatabaseSync;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const current = this.currentVersion();
    if (current === SCHEMA_VERSION) return;
    if (current === 0) {
      this.db.exec(SCHEMA_SQL);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      return;
    }
    // No down-migrations yet; future upgrades add ALTER TABLE steps here.
    throw new Error(`unsupported db schema version ${current} (expected ${SCHEMA_VERSION})`);
  }

  private currentVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  // ---------- inserts ----------

  insertRun(row: RunRow): void {
    this.db.prepare(`
      INSERT INTO runs (id, started_at, finished_at, status, target_dir, meta_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, row.started_at, row.finished_at, row.status, row.target_dir, row.meta_json);
  }

  updateRunStatus(id: string, status: RunStatus, finishedAt: string | null): void {
    this.db.prepare(`UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`)
      .run(status, finishedAt, id);
  }

  insertSession(row: SessionRow): void {
    this.db.prepare(`
      INSERT INTO sessions (
        id, run_id, task_id, task_file, model_slug, destination_slug, router,
        repeat_ix, status, started_at, finished_at, cost_usd,
        verify_exit_code, verify_stdout_tail, verify_stderr_tail,
        failure_class, worktree_path, proxy_port
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.run_id, row.task_id, row.task_file, row.model_slug,
      row.destination_slug, row.router, row.repeat_ix, row.status,
      row.started_at, row.finished_at, row.cost_usd,
      row.verify_exit_code, row.verify_stdout_tail, row.verify_stderr_tail,
      row.failure_class, row.worktree_path, row.proxy_port,
    );
  }

  updateSession(id: string, patch: Partial<SessionRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return;
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
    this.db.prepare(`UPDATE sessions SET ${setClause} WHERE id = ?`).run(...(values as any[]), id);
  }

  insertStep(row: StepRow): void {
    this.db.prepare(`
      INSERT INTO steps (
        id, session_id, step_ix, started_at, finished_at, http_status,
        inbound_shape, path, input_tokens, output_tokens, cost_usd,
        latency_ms, translation_notes, traffic_log_offset, traffic_log_length,
        failure_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.session_id, row.step_ix, row.started_at, row.finished_at,
      row.http_status, row.inbound_shape, row.path, row.input_tokens,
      row.output_tokens, row.cost_usd, row.latency_ms, row.translation_notes,
      row.traffic_log_offset, row.traffic_log_length, row.failure_class,
    );
  }

  upsertTaskMeta(taskId: string, file: string, summary: string | null, usesLlm: boolean): void {
    this.db.prepare(`
      INSERT INTO tasks_meta (task_id, file, summary, uses_llm)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET file = excluded.file, summary = excluded.summary, uses_llm = excluded.uses_llm
    `).run(taskId, file, summary, usesLlm ? 1 : 0);
  }

  // ---------- queries ----------

  getRun(id: string): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown;
    return (row ?? null) as RunRow | null;
  }

  listSessions(runId: string): SessionRow[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE run_id = ? ORDER BY started_at').all(runId) as unknown;
    return rows as SessionRow[];
  }

  listSteps(sessionId: string): StepRow[] {
    const rows = this.db.prepare('SELECT * FROM steps WHERE session_id = ? ORDER BY step_ix').all(sessionId) as unknown;
    return rows as StepRow[];
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

export const DB_FILE_NAME = 'db.sqlite';
