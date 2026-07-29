// Report data readers — SQLite + JSONL. Read-only.
//
// Design goal: one call `loadRun(runId, configDir)` returns a self-contained
// blob the renderers can walk without hitting the DB again. Keeps the render
// path pure + testable.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE_NAME } from '../db/sqlite.js';
import { iterRecords, type TrafficRecord, readRunMeta, type RunMeta } from '../runner/traffic-log.js';

// ---------- shapes ----------

export interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
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
  status: string;
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
  inbound_shape: string;
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

export interface ClassifierTagRow {
  id: string;
  session_id: string;
  dimension: string;
  value: string;
  confidence: number | null;
  generated_at: string;
  model: string;
  classifier_id: string;
  classifier_version: string;
}

export interface TaskMetaRow {
  task_id: string;
  file: string;
  summary: string | null;
  uses_llm: number;
}

export interface TrafficStats {
  totalLines: number;
  kindCounts: Record<string, number>;
  distinctSessions: number;
}

/** One session's judge verdict pivoted from classifier_tags rows. */
export interface JudgeVerdict {
  outcome?: string;
  trajectory_score?: number;
  action_score?: number;
  grounding_score?: number;
  verification_score?: number;
  efficiency_score?: number;
  judge_reasoning?: string;
  trajectory_reasoning?: string;
  classifier_version?: string;
  confidence?: number;
  trajectory_confidence?: number;
}

export interface RunData {
  runId: string;
  configDir: string;
  jsonlPath: string;
  run: RunRow;
  meta: RunMeta | null;
  sessions: SessionRow[];
  steps: StepRow[];
  stepsBySession: Map<string, StepRow[]>;
  classifierTags: ClassifierTagRow[];
  tagsBySession: Map<string, ClassifierTagRow[]>;
  verdictBySession: Map<string, JudgeVerdict>;
  tasksMeta: TaskMetaRow[];
  trafficStats: TrafficStats;
}

// ---------- entry ----------

export async function loadRun(runId: string, configDir: string): Promise<RunData> {
  const dbPath = path.join(configDir, DB_FILE_NAME);
  const jsonlPath = path.join(configDir, 'runs', runId, 'traffic.jsonl');

  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON;');

  try {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as unknown as RunRow | undefined;
    if (!run) throw new Error(`run ${runId} not found in ${dbPath}`);

    const sessions = db.prepare('SELECT * FROM sessions WHERE run_id = ? ORDER BY started_at, destination_slug, repeat_ix').all(runId) as unknown as SessionRow[];
    const sessionIds = sessions.map((s) => s.id);

    const steps = sessionIds.length > 0
      ? db.prepare(`SELECT * FROM steps WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY session_id, step_ix`).all(...sessionIds) as unknown as StepRow[]
      : [];
    const stepsBySession = new Map<string, StepRow[]>();
    for (const s of steps) {
      const arr = stepsBySession.get(s.session_id) ?? stepsBySession.set(s.session_id, []).get(s.session_id)!;
      arr.push(s);
    }

    const classifierTags = sessionIds.length > 0
      ? db.prepare(`SELECT * FROM classifier_tags WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY session_id, dimension`).all(...sessionIds) as unknown as ClassifierTagRow[]
      : [];
    const tagsBySession = new Map<string, ClassifierTagRow[]>();
    for (const t of classifierTags) {
      const arr = tagsBySession.get(t.session_id) ?? tagsBySession.set(t.session_id, []).get(t.session_id)!;
      arr.push(t);
    }
    const verdictBySession = pivotVerdicts(tagsBySession);

    const tasksMeta = db.prepare('SELECT * FROM tasks_meta').all() as unknown as TaskMetaRow[];

    // meta.json — optional; older runs may not have it.
    const meta = await readRunMeta(configDir, runId);

    // Traffic stats (cheap pass — line count + kind counts, no body inflation).
    const trafficStats = await scanTraffic(jsonlPath);

    return {
      runId, configDir, jsonlPath,
      run, meta, sessions, steps, stepsBySession,
      classifierTags, tagsBySession, verdictBySession,
      tasksMeta, trafficStats,
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function pivotVerdicts(tagsBySession: Map<string, ClassifierTagRow[]>): Map<string, JudgeVerdict> {
  const out = new Map<string, JudgeVerdict>();
  for (const [sessionId, rows] of tagsBySession) {
    const v: JudgeVerdict = {};
    for (const r of rows) {
      switch (r.dimension) {
        case 'outcome': v.outcome = r.value; v.confidence = r.confidence ?? undefined; break;
        case 'trajectory_score': v.trajectory_score = Number(r.value); v.trajectory_confidence = r.confidence ?? undefined; break;
        case 'action_score': v.action_score = Number(r.value); break;
        case 'grounding_score': v.grounding_score = Number(r.value); break;
        case 'verification_score': v.verification_score = Number(r.value); break;
        case 'efficiency_score': v.efficiency_score = Number(r.value); break;
        case 'judge_reasoning': v.judge_reasoning = r.value; break;
        case 'trajectory_reasoning': v.trajectory_reasoning = r.value; break;
      }
      if (!v.classifier_version) v.classifier_version = r.classifier_version;
    }
    out.set(sessionId, v);
  }
  return out;
}

async function scanTraffic(jsonlPath: string): Promise<TrafficStats> {
  const kindCounts: Record<string, number> = {};
  const sessionIds = new Set<string>();
  let totalLines = 0;
  try {
    for await (const rec of iterRecords(jsonlPath)) {
      totalLines++;
      const k = rec.kind ?? 'unknown';
      kindCounts[k] = (kindCounts[k] ?? 0) + 1;
      if (rec.session_id) sessionIds.add(rec.session_id);
    }
  } catch {
    // File missing / unreadable — return empty stats
  }
  return { totalLines, kindCounts, distinctSessions: sessionIds.size };
}

// ---------- column distributions (Layer 2) ----------

export type ColumnDistribution =
  | { kind: 'numeric'; count: number; nulls: number; min: number; max: number; avg: number }
  | { kind: 'enum'; count: number; nulls: number; unique: number; top: Array<{ value: string; count: number }>; dead: boolean }
  | { kind: 'text'; count: number; nulls: number; avgLen: number; sample: string }
  | { kind: 'timestamp'; count: number; nulls: number; earliest: string; latest: string; spanSec: number }
  | { kind: 'id'; count: number; nulls: number; unique: number }
  | { kind: 'empty'; count: 0; nulls: number };

const NUMERIC_HINTS = new Set([
  'cost_usd', 'input_tokens', 'output_tokens', 'latency_ms', 'http_status',
  'repeat_ix', 'step_ix', 'verify_exit_code', 'proxy_port', 'confidence',
  'traffic_log_offset', 'traffic_log_length', 'uses_llm',
]);
const TIMESTAMP_HINTS = new Set(['started_at', 'finished_at', 'generated_at']);
const ID_HINTS = new Set(['id', 'run_id', 'session_id', 'step_id', 'task_id']);
const TEXT_HINTS = new Set([
  'verify_stdout_tail', 'verify_stderr_tail', 'judge_reasoning',
  'trajectory_reasoning', 'meta_json', 'summary', 'translation_notes',
  'worktree_path', 'target_dir', 'task_file',
]);

export function describeColumn(rows: Array<Record<string, unknown>>, col: string): ColumnDistribution {
  if (rows.length === 0) return { kind: 'empty', count: 0, nulls: 0 };
  const values = rows.map((r) => r[col]);
  const nulls = values.filter((v) => v === null || v === undefined).length;
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  const count = nonNull.length;

  if (count === 0) return { kind: 'empty', count: 0, nulls };

  if (ID_HINTS.has(col)) {
    return { kind: 'id', count, nulls, unique: new Set(nonNull.map(String)).size };
  }
  if (TIMESTAMP_HINTS.has(col)) {
    const times = nonNull.map((v) => new Date(String(v)).getTime()).filter((n) => isFinite(n)).sort();
    return {
      kind: 'timestamp', count, nulls,
      earliest: new Date(times[0]).toISOString(),
      latest: new Date(times[times.length - 1]).toISOString(),
      spanSec: (times[times.length - 1] - times[0]) / 1000,
    };
  }
  if (TEXT_HINTS.has(col)) {
    const strs = nonNull.map((v) => String(v));
    const total = strs.reduce((a, s) => a + s.length, 0);
    const sample = strs.reduce((a, b) => (b.length > a.length ? b : a), '');
    return { kind: 'text', count, nulls, avgLen: Math.round(total / count), sample: sample.slice(0, 240) };
  }
  if (NUMERIC_HINTS.has(col) || nonNull.every((v) => typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v))))) {
    const nums = nonNull.map((v) => Number(v)).filter((n) => isFinite(n));
    if (nums.length > 0) {
      const min = Math.min(...nums), max = Math.max(...nums);
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      return { kind: 'numeric', count, nulls, min, max, avg };
    }
  }

  // Enum-like: value counts, ordered by frequency
  const freq = new Map<string, number>();
  for (const v of nonNull) {
    const key = String(v);
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5).map(([value, c]) => ({ value, count: c }));
  return { kind: 'enum', count, nulls, unique: freq.size, top, dead: freq.size <= 1 };
}

// ---------- Layer 3: JSON body walker ----------

export interface JsonKeyProfile {
  path: string;                                       // dotted path, e.g. ".choices[].message.content"
  types: Set<'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'>;
  present: number;                                    // count of records this key appears in
  totalRecords: number;                               // denominator for presence %
  numeric?: { min: number; max: number; avg: number };
  stringSampleLen?: { min: number; max: number; avg: number };
  enumTop?: Array<{ value: string; count: number }>;
  arrayLens?: { min: number; max: number; avg: number };
}

/** Walk a stream of JSON objects, aggregate a schema map. */
export function profileJsonRecords(records: unknown[]): Map<string, JsonKeyProfile> {
  const profiles = new Map<string, JsonKeyProfile>();
  for (const rec of records) walk(rec, '', profiles, records.length);
  return profiles;
}

function walk(v: unknown, currPath: string, out: Map<string, JsonKeyProfile>, total: number): void {
  const p = currPath || '.';
  const prof = out.get(p) ?? {
    path: p, types: new Set(), present: 0, totalRecords: total,
  } as JsonKeyProfile;
  prof.present++;

  const type: JsonKeyProfile['types'] extends Set<infer T> ? T : never =
    v === null ? 'null'
    : Array.isArray(v) ? 'array'
    : typeof v === 'object' ? 'object'
    : typeof v === 'string' ? 'string'
    : typeof v === 'number' ? 'number'
    : typeof v === 'boolean' ? 'boolean'
    : 'null';

  prof.types.add(type as never);

  if (type === 'number') {
    const n = v as number;
    if (isFinite(n)) {
      const cur = prof.numeric ?? { min: Infinity, max: -Infinity, avg: 0 };
      cur.min = Math.min(cur.min, n);
      cur.max = Math.max(cur.max, n);
      // running avg via (avg * (n-1) + v) / n where n = number of numeric samples so far
      // approximate: use present as N since numeric hits are recorded here
      cur.avg = cur.avg + (n - cur.avg) / prof.present;
      prof.numeric = cur;
    }
  } else if (type === 'string') {
    const s = v as string;
    const cur = prof.stringSampleLen ?? { min: Infinity, max: -Infinity, avg: 0 };
    cur.min = Math.min(cur.min, s.length);
    cur.max = Math.max(cur.max, s.length);
    cur.avg = cur.avg + (s.length - cur.avg) / prof.present;
    prof.stringSampleLen = cur;
    // enum-like tracking — only useful for short strings
    if (s.length <= 40) {
      const bag = (prof.enumTop ?? []) as Array<{ value: string; count: number }>;
      const hit = bag.find((x) => x.value === s);
      if (hit) hit.count++;
      else if (bag.length < 20) bag.push({ value: s, count: 1 });
      prof.enumTop = bag;
    }
  } else if (type === 'array') {
    const arr = v as unknown[];
    const cur = prof.arrayLens ?? { min: Infinity, max: -Infinity, avg: 0 };
    cur.min = Math.min(cur.min, arr.length);
    cur.max = Math.max(cur.max, arr.length);
    cur.avg = cur.avg + (arr.length - cur.avg) / prof.present;
    prof.arrayLens = cur;
    // Recurse into first few elements — use [] index in path.
    for (const item of arr) walk(item, `${p}[]`, out, total);
  } else if (type === 'object') {
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      const nextPath = p === '.' ? `.${key}` : `${p}.${key}`;
      walk(val, nextPath, out, total);
    }
  }

  out.set(p, prof);
}

/** Read every TrafficRecord's body for a given kind and profile the JSON shape. */
export async function profileTrafficBodies(jsonlPath: string, kind: 'request' | 'response'): Promise<Map<string, JsonKeyProfile>> {
  const bodies: unknown[] = [];
  try {
    for await (const rec of iterRecords(jsonlPath)) {
      if (rec.kind === kind && rec.body !== undefined) bodies.push(rec.body);
    }
  } catch { /* fall through */ }
  return profileJsonRecords(bodies);
}

// ---------- lane rollup (shared by leaderboard/lane-table/heatmap/aggregate) ----------

export interface LaneRollup {
  laneKey: string;                    // destination_slug
  modelSlug: string;
  destSlug: string;
  router: string;
  attempted: number;
  passed: number;
  spend: number;
  perTask: Map<string, { attempted: number; passed: number; spend: number; latencies: number[] }>;
  latenciesMs: number[];              // all step latencies across the lane
  trajSum: number;
  trajCount: number;
  avgTraj: number | null;
  dollarsPerPass: number | null;
  weightedDollarsPerPass: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

export function computeLaneRollups(data: RunData): LaneRollup[] {
  const bySlug = new Map<string, LaneRollup>();
  for (const s of data.sessions) {
    const key = s.destination_slug;
    let r = bySlug.get(key);
    if (!r) {
      r = {
        laneKey: key,
        modelSlug: s.model_slug,
        destSlug: s.destination_slug,
        router: s.router,
        attempted: 0, passed: 0, spend: 0,
        perTask: new Map(),
        latenciesMs: [],
        trajSum: 0, trajCount: 0, avgTraj: null,
        dollarsPerPass: null, weightedDollarsPerPass: null,
        p50LatencyMs: null, p95LatencyMs: null,
      };
      bySlug.set(key, r);
    }
    r.attempted++;
    if (s.status === 'complete') r.passed++;
    r.spend += s.cost_usd ?? 0;
    const t = r.perTask.get(s.task_id) ?? { attempted: 0, passed: 0, spend: 0, latencies: [] };
    t.attempted++;
    if (s.status === 'complete') t.passed++;
    t.spend += s.cost_usd ?? 0;
    const steps = data.stepsBySession.get(s.id) ?? [];
    for (const step of steps) {
      if (step.latency_ms != null) {
        r.latenciesMs.push(step.latency_ms);
        t.latencies.push(step.latency_ms);
      }
    }
    r.perTask.set(s.task_id, t);
    const v = data.verdictBySession.get(s.id);
    if (v?.trajectory_score != null) {
      r.trajSum += v.trajectory_score;
      r.trajCount++;
    }
  }
  for (const r of bySlug.values()) {
    if (r.trajCount > 0) r.avgTraj = Math.round(r.trajSum / r.trajCount);
    if (r.passed > 0) r.dollarsPerPass = r.spend / r.passed;
    if (r.dollarsPerPass != null && r.avgTraj != null && r.avgTraj > 0) {
      r.weightedDollarsPerPass = r.dollarsPerPass / (r.avgTraj / 100);
    }
    if (r.latenciesMs.length > 0) {
      r.p50LatencyMs = percentile(r.latenciesMs, 0.5);
      r.p95LatencyMs = percentile(r.latenciesMs, 0.95);
    }
  }
  return [...bySlug.values()];
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

/** Rank lanes for the "Best value" / "Cheapest raw" / "Winner" callouts. */
export interface LaneRankings {
  bestValue: LaneRollup | null;      // lowest weighted $/pass with ≥1 pass
  cheapestRaw: LaneRollup | null;    // lowest raw $/pass with ≥1 pass
  highestTraj: LaneRollup | null;    // highest avg traj
  mostExpensive: LaneRollup | null;  // highest weighted $/pass with ≥1 pass
}

export function rankLanes(lanes: LaneRollup[]): LaneRankings {
  const passing = lanes.filter((l) => l.passed > 0);
  const withWeighted = passing.filter((l) => l.weightedDollarsPerPass != null);
  const withRaw = passing.filter((l) => l.dollarsPerPass != null);
  const withTraj = lanes.filter((l) => l.avgTraj != null);
  const sortedWeighted = [...withWeighted].sort((a, b) => a.weightedDollarsPerPass! - b.weightedDollarsPerPass!);
  return {
    bestValue: sortedWeighted[0] ?? null,
    mostExpensive: sortedWeighted[sortedWeighted.length - 1] ?? null,
    cheapestRaw: [...withRaw].sort((a, b) => a.dollarsPerPass! - b.dollarsPerPass!)[0] ?? null,
    highestTraj: [...withTraj].sort((a, b) => b.avgTraj! - a.avgTraj!)[0] ?? null,
  };
}

// ---------- convenience: file existence ----------

export function jsonlExists(configDir: string, runId: string): boolean {
  return fs.existsSync(path.join(configDir, 'runs', runId, 'traffic.jsonl'));
}
