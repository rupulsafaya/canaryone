// Post-run ASCII summary. Reads .c1/db.sqlite for the given runId, groups
// by lane (destinationSlug), joins classifier_tags for the trajectory score,
// renders a Lane / Pass / $/pass / Traj / Weighted $/pass table.
//
// Called by the orchestrator after judgePool.drain() but before the
// run:complete event. In TUI mode the caller passes printSummary=false so
// stdout doesn't collide with Ink's alternate-screen buffer; a follow-up
// `c1 runs summary <runId>` CLI subcommand can render it later.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fmtDollars, fmtDuration } from '../lib/fmt.js';
import { DB_FILE_NAME } from '../db/sqlite.js';

export interface PrintSummaryOpts {
  stream?: NodeJS.WritableStream;
  /** When true, omit ANSI colors. Defaults to true (plain ASCII, matches SPEC mock). */
  plain?: boolean;
}

interface LaneRoll {
  laneKey: string;                // "<router>:<providerSlug>" — the destination_slug
  displayName: string;
  attempted: number;
  passed: number;
  spend: number;
  hasJudge: boolean;
  avgTraj: number | null;
}

export function printRunSummary(runId: string, configDir: string, opts: PrintSummaryOpts = {}): void {
  const stream = opts.stream ?? process.stdout;
  const dbPath = path.join(configDir, DB_FILE_NAME);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    render(db, runId, stream);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function render(db: DatabaseSync, runId: string, stream: NodeJS.WritableStream): void {
  const run = db.prepare('SELECT started_at, finished_at FROM runs WHERE id = ?').get(runId) as
    { started_at?: string; finished_at?: string | null } | undefined;
  if (!run) {
    stream.write(`(no run ${runId} in db)\n`);
    return;
  }

  const sessions = db.prepare(`
    SELECT id, destination_slug, model_slug, router, status, cost_usd
    FROM sessions
    WHERE run_id = ?
  `).all(runId) as Array<{
    id: string;
    destination_slug: string;
    model_slug: string;
    router: string;
    status: string;
    cost_usd: number;
  }>;

  const trajBySession = new Map<string, number>();
  const trajRows = db.prepare(`
    SELECT session_id, value
    FROM classifier_tags
    WHERE dimension = 'trajectory_score' AND session_id IN (${sessions.map(() => '?').join(',') || 'NULL'})
  `).all(...sessions.map((s) => s.id)) as Array<{ session_id: string; value: string }>;
  for (const r of trajRows) {
    const n = Number(r.value);
    if (Number.isFinite(n)) trajBySession.set(r.session_id, n);
  }

  // Roll up per lane.
  const byLane = new Map<string, LaneRoll>();
  for (const s of sessions) {
    const key = s.destination_slug;
    let roll = byLane.get(key);
    if (!roll) {
      roll = {
        laneKey: key,
        displayName: `${s.model_slug}@${s.destination_slug}`,
        attempted: 0, passed: 0, spend: 0,
        hasJudge: false, avgTraj: null,
      };
      byLane.set(key, roll);
    }
    roll.attempted++;
    if (s.status === 'complete') roll.passed++;
    roll.spend += s.cost_usd ?? 0;
    const traj = trajBySession.get(s.id);
    if (traj !== undefined) {
      roll.hasJudge = true;
      roll.avgTraj = roll.avgTraj === null ? traj : roll.avgTraj + traj;
    }
  }
  // Finalize averages
  for (const roll of byLane.values()) {
    if (roll.hasJudge && roll.avgTraj !== null) {
      // Count sessions that had traj tags for this lane (subset of attempted)
      const withTraj = sessions.filter((s) => s.destination_slug === roll.laneKey && trajBySession.has(s.id)).length;
      if (withTraj > 0) roll.avgTraj = Math.round(roll.avgTraj / withTraj);
    }
  }

  const rolls = Array.from(byLane.values());
  const anyJudge = rolls.some((r) => r.hasJudge);
  const showTrajCols = anyJudge;

  // Compute derived + sort key per lane
  interface DerivedRoll extends LaneRoll {
    dollarsPerPass: number | null;   // null when passed=0
    weightedDollarsPerPass: number | null; // null when passed=0 or no traj
  }
  const derived: DerivedRoll[] = rolls.map((r) => {
    const dpp = r.passed > 0 ? r.spend / r.passed : null;
    const wpp = (dpp !== null && r.avgTraj !== null && r.avgTraj > 0)
      ? dpp / (r.avgTraj / 100)
      : null;
    return { ...r, dollarsPerPass: dpp, weightedDollarsPerPass: wpp };
  });

  // Sort: rows with a weighted $/pass first (asc); then rows with only raw $/pass
  // (asc); then 0-pass rows at the bottom (by attempted desc for stability).
  derived.sort((a, b) => {
    const aRank = a.weightedDollarsPerPass !== null ? 0 : a.dollarsPerPass !== null ? 1 : 2;
    const bRank = b.weightedDollarsPerPass !== null ? 0 : b.dollarsPerPass !== null ? 1 : 2;
    if (aRank !== bRank) return aRank - bRank;
    if (aRank === 0) return (a.weightedDollarsPerPass! - b.weightedDollarsPerPass!);
    if (aRank === 1) return (a.dollarsPerPass! - b.dollarsPerPass!);
    return b.attempted - a.attempted;
  });

  // Table rendering
  const shortId = runId.slice(0, 8);
  stream.write(`\n=== Run complete · ${shortId} ===\n\n`);

  const headers = showTrajCols
    ? ['Lane', 'Pass', '$/pass', 'Traj', 'Weighted $/pass']
    : ['Lane', 'Pass', '$/pass'];

  const rows: string[][] = derived.map((r) => {
    const pass = `${r.passed}/${r.attempted}`;
    const dpp = r.dollarsPerPass !== null ? fmtDollars(r.dollarsPerPass) : '—';
    if (!showTrajCols) return [`● ${r.displayName}`, pass, dpp];
    const trajStr = r.avgTraj === null ? '—' : `${r.avgTraj}${r.avgTraj < 50 ? ' ⚠' : ''}`;
    const wpp = r.weightedDollarsPerPass !== null ? fmtDollars(r.weightedDollarsPerPass) : '—';
    return [`● ${r.displayName}`, pass, dpp, trajStr, wpp];
  });

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i]).length)));

  const renderRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] + 2)).join('').trimEnd() + '\n';

  stream.write(renderRow(headers));
  stream.write('─'.repeat(widths.reduce((a, w) => a + w + 2, 0)) + '\n');
  for (const r of rows) stream.write(renderRow(r));

  // Best value / Cheapest raw lines (only when judge data exists)
  if (showTrajCols) {
    const eligible = derived.filter((r) => r.passed > 0);
    const bestValue = eligible
      .filter((r) => r.weightedDollarsPerPass !== null)
      .sort((a, b) => a.weightedDollarsPerPass! - b.weightedDollarsPerPass!)[0];
    const cheapestRaw = eligible
      .filter((r) => r.dollarsPerPass !== null)
      .sort((a, b) => a.dollarsPerPass! - b.dollarsPerPass!)[0];
    if (bestValue) {
      const trajTag = bestValue.avgTraj !== null ? `, traj ${bestValue.avgTraj}` : '';
      stream.write(`\nBest value: ${bestValue.displayName}   (${fmtDollars(bestValue.weightedDollarsPerPass!)} per grounded pass${trajTag})\n`);
    }
    if (cheapestRaw) {
      const trajTag = cheapestRaw.avgTraj !== null
        ? `, traj ${cheapestRaw.avgTraj}${cheapestRaw.avgTraj < 50 ? ' ⚠ narrated' : ''}`
        : '';
      stream.write(`Cheapest raw: ${cheapestRaw.displayName}   (${fmtDollars(cheapestRaw.dollarsPerPass!)} per pass${trajTag})\n`);
    }
  }

  // Footer
  const totalSpend = rolls.reduce((a, r) => a + r.spend, 0);
  const elapsed = run.started_at && run.finished_at
    ? (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000
    : 0;
  stream.write('─'.repeat(60) + '\n');
  stream.write(`Total spend: ${fmtDollars(totalSpend)}   Elapsed: ${fmtDuration(elapsed)}\n`);
}

// Very light ANSI strip so column widths align even if a cell ever contains
// escapes (currently none — we render plain ASCII — but future-proof).
function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, '');
}
