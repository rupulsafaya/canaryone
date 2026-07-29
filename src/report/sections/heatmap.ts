// §03 Heatmap · lanes × tasks. Cells colored by weighted $/pass (or raw
// via the toggle). Log10-bucketed 1..8 gradient (green → red).
// Rightmost column: per-lane weighted $/pass summary.

import { computeLaneRollups, type RunData, type LaneRollup } from '../data.js';
import { escapeHtml } from '../template.js';
import { fmtDollars } from '../../lib/fmt.js';

interface CellData {
  raw: number | null;         // task-level $/pass
  weighted: number | null;    // task-level weighted $/pass (uses lane's avgTraj — task-level traj rare in current data)
  passed: number;
  attempted: number;
}

export function renderHeatmap(data: RunData): string {
  const lanes = computeLaneRollups(data);
  const taskIds = [...new Set(data.sessions.map((s) => s.task_id))].sort();
  if (lanes.length === 0 || taskIds.length === 0) {
    return `
<section id="s3">
  <h2><span class="sec-num">03</span>Heatmap · lanes × tasks</h2>
  <p class="muted">(no data)</p>
</section>`;
  }

  // Build (lane, task) matrix.
  const matrix = new Map<string, Map<string, CellData>>();
  for (const l of lanes) {
    const row = new Map<string, CellData>();
    for (const t of taskIds) {
      const perT = l.perTask.get(t);
      if (!perT) {
        row.set(t, { raw: null, weighted: null, passed: 0, attempted: 0 });
        continue;
      }
      const raw = perT.passed > 0 ? perT.spend / perT.passed : null;
      const weighted = (raw != null && l.avgTraj != null && l.avgTraj > 0)
        ? raw / (l.avgTraj / 100) : null;
      row.set(t, { raw, weighted, passed: perT.passed, attempted: perT.attempted });
    }
    matrix.set(l.laneKey, row);
  }

  // Bucket for coloring: log10 of the metric across all non-null cells.
  const allWeighted: number[] = [];
  const allRaw: number[] = [];
  for (const row of matrix.values()) {
    for (const c of row.values()) {
      if (c.weighted != null) allWeighted.push(c.weighted);
      if (c.raw != null) allRaw.push(c.raw);
    }
  }
  const bucketOfWeighted = makeBucketer(allWeighted);
  const bucketOfRaw = makeBucketer(allRaw);

  // Sort rows by weighted $/pass ascending (winner at top).
  const orderedLanes = [...lanes].sort((a, b) => {
    const aw = a.weightedDollarsPerPass, bw = b.weightedDollarsPerPass;
    if (aw != null && bw != null) return aw - bw;
    if (aw != null) return -1;
    if (bw != null) return 1;
    return 0;
  });

  const rowHtml = orderedLanes.map((l) => renderRow(l, matrix.get(l.laneKey)!, taskIds, bucketOfWeighted, bucketOfRaw)).join('');

  const taskHeaders = taskIds.map((t) => `<th>${escapeHtml(t)}</th>`).join('');

  return `
<section id="s3">
  <h2><span class="sec-num">03</span>Heatmap · lanes × tasks</h2>
  <details class="explain">
    <summary>How to read this chart</summary>
    <div class="explain-body">
      <p>One row per lane, one column per task. Cell color = weighted \$/pass gradient (green cheapest → red most expensive). Cell text = raw \$/pass for that (lane, task) combination. Right-most column shows the lane's overall weighted \$/pass with judge score badge. Toggle to <strong>raw</strong> to color by raw \$/pass instead — surfaces "cheap by naive metric" lanes that hide a low judge score.</p>
    </div>
  </details>
  <div class="heat-toggle">
    <span class="label">Color by:</span>
    <button class="active" data-mode="weighted">Weighted \$/pass</button>
    <button data-mode="raw">Raw \$/pass</button>
  </div>
  <div class="heatmap-wrap">
    <table class="heatmap">
      <thead>
        <tr>
          <th class="lane-label">Lane</th>
          ${taskHeaders}
          <th>Weighted \$/pass</th>
        </tr>
      </thead>
      <tbody>${rowHtml}</tbody>
    </table>
  </div>
</section>`;
}

function renderRow(
  lane: LaneRollup,
  row: Map<string, CellData>,
  taskIds: string[],
  bucketWeighted: (n: number) => number,
  bucketRaw: (n: number) => number,
): string {
  const cells = taskIds.map((t) => {
    const c = row.get(t)!;
    if (c.raw == null) {
      return `<td class="no-pass">—</td>`;
    }
    const bw = c.weighted != null ? bucketWeighted(c.weighted) : bucketRaw(c.raw);
    const br = bucketRaw(c.raw);
    return `<td class="heat-${bw}" data-heat-weighted="${bw}" data-heat-raw="${br}" title="${c.passed}/${c.attempted} pass">${escapeHtml(fmtDollars(c.raw))}</td>`;
  }).join('');

  const summary = lane.weightedDollarsPerPass != null
    ? `${fmtDollars(lane.weightedDollarsPerPass)}${lane.avgTraj != null ? ` <span class="muted">(judge ${lane.avgTraj}${lane.avgTraj < 50 ? ' ⚠' : ''})</span>` : ''}`
    : '<span class="muted">—</span>';

  return `
    <tr>
      <td class="lane-label">${escapeHtml(lane.destSlug)}</td>
      ${cells}
      <td class="summary">${summary}</td>
    </tr>`;
}

// Bucket a value into 1..8 via log10 across the observed range.
function makeBucketer(values: number[]): (n: number) => number {
  if (values.length === 0) return () => 4;
  const logs = values.map((v) => Math.log10(Math.max(v, 1e-12)));
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  const range = Math.max(0.001, max - min);
  return (n: number) => {
    const l = Math.log10(Math.max(n, 1e-12));
    const t = (l - min) / range;
    return Math.min(8, Math.max(1, Math.floor(t * 8) + 1));
  };
}
