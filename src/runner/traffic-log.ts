// Append-only JSONL wire log at .c1/runs/<run_id>/traffic.jsonl.
// Source of truth for what happened between subprocess and destination.
// SQLite indexes byte-offsets into this file for O(1) body lookup (§15.2).
//
// Invariant: every event is fsync'd BEFORE the corresponding SQLite row
// commits. If the process dies between JSONL write and SQLite commit,
// `c1 run --continue` will replay the tail into SQLite.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type TrafficKind = 'request' | 'response' | 'chunk' | 'error' | 'resume-marker' | 'session-start' | 'session-end';

export interface TrafficRecord {
  ts: string;
  kind: TrafficKind;
  run_id: string;
  session_id: string | null;
  step_id: string | null;
  step_ix: number | null;
  lane?: { model: string; destination: string };
  inbound_shape?: 'openai' | 'anthropic';
  path?: string;
  translation_notes?: unknown;
  body?: unknown;
  sse_chunk?: string;
  usage?: { input_tokens: number; output_tokens: number };
  latency_ms?: number | null;
  cost_usd?: number | null;
  http_status?: number | null;
  note?: string;
  error?: string;
}

/** Result of appending a record — byte offsets into traffic.jsonl for later indexing. */
export interface AppendResult {
  offset: number;   // start byte
  length: number;   // JSON line length (excluding the trailing '\n')
}

export interface TrafficLog {
  path: string;
  append(rec: TrafficRecord): Promise<AppendResult>;
  close(): Promise<void>;
}

/** Open (create) the traffic log at .c1/runs/<runId>/traffic.jsonl. */
export async function openTrafficLog(configDir: string, runId: string): Promise<TrafficLog> {
  const runDir = path.join(configDir, 'runs', runId);
  await fsp.mkdir(runDir, { recursive: true });
  const filePath = path.join(runDir, 'traffic.jsonl');
  // Open for append; O_APPEND ensures atomicity of the write w.r.t. offset.
  const fh = await fsp.open(filePath, 'a');
  let offset = (await fh.stat()).size;

  return {
    path: filePath,
    async append(rec: TrafficRecord): Promise<AppendResult> {
      const line = JSON.stringify(rec) + '\n';
      const buf = Buffer.from(line, 'utf8');
      const written = await fh.write(buf, 0, buf.length, offset);
      const length = buf.length - 1;   // excluding '\n'
      const startOffset = offset;
      offset += written.bytesWritten;
      await fh.sync();
      return { offset: startOffset, length };
    },
    async close() {
      try { await fh.close(); } catch { /* already closed */ }
    },
  };
}

/** Read a specific record range back — used by SessionInspector (D3+). */
export async function readRange(logPath: string, offset: number, length: number): Promise<string> {
  const fh = await fsp.open(logPath, 'r');
  try {
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, offset);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Iterate all records — used for resume replay and traffic.md regeneration. */
export async function* iterRecords(logPath: string): AsyncGenerator<TrafficRecord> {
  const raw = await fsp.readFile(logPath, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as TrafficRecord; } catch { /* skip malformed */ }
  }
}

// ---------- run metadata ----------

export interface RunMeta {
  runId: string;
  startedAt: string;
  targetDir: string;
  configDir: string;
  parallelism: number;
  repeats: number;
  lanes: Array<{ model: string; destination: string; router: string }>;
  tasks: Array<{ id: string; file: string }>;
}

export async function writeRunMeta(configDir: string, runId: string, meta: RunMeta): Promise<string> {
  const runDir = path.join(configDir, 'runs', runId);
  await fsp.mkdir(runDir, { recursive: true });
  const p = path.join(runDir, 'meta.json');
  await fsp.writeFile(p, JSON.stringify(meta, null, 2));
  return p;
}

export async function readRunMeta(configDir: string, runId: string): Promise<RunMeta | null> {
  const p = path.join(configDir, 'runs', runId, 'meta.json');
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw) as RunMeta;
  } catch {
    return null;
  }
}

// ---------- per-session markdown ----------

/**
 * Write the human-readable session narrative to
 * .c1/runs/<runId>/sessions/<sessionId>.md. Regenerable from JSONL byte
 * ranges — this is derived, not source-of-truth.
 */
export async function writeSessionMarkdown(
  configDir: string,
  runId: string,
  sessionId: string,
  contents: string,
): Promise<string> {
  const sessionsDir = path.join(configDir, 'runs', runId, 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const p = path.join(sessionsDir, `${sessionId}.md`);
  await fsp.writeFile(p, contents);
  return p;
}

// synchronous sibling for lifecycle hooks that can't await
export function runDirSync(configDir: string, runId: string): string {
  const p = path.join(configDir, 'runs', runId);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
