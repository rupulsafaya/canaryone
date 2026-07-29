// §05 Aggregate stats card — the "cost analysis" summary block.
// Includes: Best value, Cheapest raw (with ⚠ callout if narrated),
// Most expensive, Spread, Direct-vs-OR delta (when direct lanes present).

import { computeLaneRollups, rankLanes, type RunData, type LaneRollup } from '../data.js';
import { escapeHtml } from '../template.js';
import { fmtDollars, fmtDuration } from '../../lib/fmt.js';

export function renderAggregate(data: RunData): string {
  const lanes = computeLaneRollups(data);
  const ranks = rankLanes(lanes);
  const totalSpend = lanes.reduce((a, l) => a + l.spend, 0);
  const totalPassed = lanes.reduce((a, l) => a + l.passed, 0);
  const totalAttempted = lanes.reduce((a, l) => a + l.attempted, 0);
  const elapsed = data.run.started_at && data.run.finished_at
    ? (new Date(data.run.finished_at).getTime() - new Date(data.run.started_at).getTime()) / 1000
    : 0;

  // Direct vs OR (when both exist)
  const directLanes = lanes.filter((l) => l.router === 'direct');
  const orLanes = lanes.filter((l) => l.router === 'openrouter');
  const directBest = bestWeighted(directLanes);
  const orBest = bestWeighted(orLanes);
  let directVsOr = '';
  if (directBest && orBest && directBest.weightedDollarsPerPass && orBest.weightedDollarsPerPass) {
    const delta = ((orBest.weightedDollarsPerPass - directBest.weightedDollarsPerPass) / orBest.weightedDollarsPerPass) * 100;
    const direction = delta > 0 ? 'beats' : 'loses to';
    directVsOr = `Best direct (<code>${escapeHtml(directBest.destSlug)}</code>) ${direction} best OR route (<code>${escapeHtml(orBest.destSlug)}</code>) by <strong>${Math.abs(delta).toFixed(1)}%</strong> weighted.`;
  }

  // Narrated call-out (Groq-style): cheapest raw's traj < 50
  const narratedCallout = ranks.cheapestRaw && ranks.cheapestRaw.avgTraj != null && ranks.cheapestRaw.avgTraj < 50 && ranks.cheapestRaw !== ranks.bestValue
    ? `
    <div class="aggregate-callout">
      <strong>⚠ ${escapeHtml(ranks.cheapestRaw.destSlug)}</strong> is cheapest by raw \$/pass (<code>${escapeHtml(fmtDollars(ranks.cheapestRaw.dollarsPerPass!))}</code>) but scores <strong>judge score ${ranks.cheapestRaw.avgTraj}</strong> — the passing test may not reflect real work. Weighted \$/pass = <code>${escapeHtml(fmtDollars(ranks.cheapestRaw.weightedDollarsPerPass!))}</code>. See <em>How we measure</em> above and §4.5 in the SPEC for interpretation.
    </div>`
    : '';

  const spread = (ranks.bestValue?.weightedDollarsPerPass != null
    && ranks.mostExpensive?.weightedDollarsPerPass != null
    && ranks.bestValue.weightedDollarsPerPass > 0)
    ? ranks.mostExpensive.weightedDollarsPerPass / ranks.bestValue.weightedDollarsPerPass
    : null;

  return `
<section id="s5">
  <h2><span class="sec-num">05</span>Aggregate stats</h2>
  <div class="aggregate-card">
    <h4>Cost analysis</h4>
    ${row('Best value', ranks.bestValue
      ? `<span class="lane">${escapeHtml(ranks.bestValue.destSlug)}</span> · <span class="num">${escapeHtml(fmtDollars(ranks.bestValue.weightedDollarsPerPass!))}</span> per grounded pass ${ranks.bestValue.avgTraj != null ? `(judge ${ranks.bestValue.avgTraj})` : ''}`
      : '<span class="muted">—</span>')}
    ${row('Cheapest raw', ranks.cheapestRaw
      ? `<span class="lane">${escapeHtml(ranks.cheapestRaw.destSlug)}</span> · <span class="num">${escapeHtml(fmtDollars(ranks.cheapestRaw.dollarsPerPass!))}</span> per pass ${ranks.cheapestRaw.avgTraj != null ? `(judge ${ranks.cheapestRaw.avgTraj}${ranks.cheapestRaw.avgTraj < 50 ? ' ⚠ narrated' : ''})` : ''}`
      : '<span class="muted">—</span>')}
    ${row('Most expensive weighted', ranks.mostExpensive && ranks.mostExpensive !== ranks.bestValue
      ? `<span class="lane">${escapeHtml(ranks.mostExpensive.destSlug)}</span> · <span class="num">${escapeHtml(fmtDollars(ranks.mostExpensive.weightedDollarsPerPass!))}</span> per grounded pass ${ranks.mostExpensive.avgTraj != null ? `(judge ${ranks.mostExpensive.avgTraj})` : ''}`
      : '<span class="muted">(only one lane, no spread)</span>')}
    ${row('Spread (weighted)', spread != null
      ? `<strong>${spread.toFixed(1)}×</strong> best-value → most-expensive on identical work`
      : '<span class="muted">—</span>')}
    ${row('Highest judge score', ranks.highestTraj
      ? `<span class="lane">${escapeHtml(ranks.highestTraj.destSlug)}</span> · <strong>${ranks.highestTraj.avgTraj}</strong>/100`
      : '<span class="muted">—</span>')}
    ${directVsOr ? row('Direct vs OR', directVsOr) : ''}
    ${row('Pass rate', `<strong>${totalPassed}/${totalAttempted}</strong> ${totalAttempted > 0 ? `<span class="muted">(${Math.round((totalPassed / totalAttempted) * 100)}%)</span>` : ''}`)}
    ${row('Total spend', `<span class="num">${escapeHtml(fmtDollars(totalSpend))}</span>`)}
    ${row('Elapsed', elapsed > 0 ? fmtDuration(elapsed) : '<span class="muted">—</span>')}
    ${narratedCallout}
  </div>
</section>`;
}

function row(label: string, valHtml: string): string {
  return `
    <div class="aggregate-row">
      <span class="lbl">${escapeHtml(label)}</span>
      <span class="val">${valHtml}</span>
    </div>`;
}

function bestWeighted(lanes: LaneRollup[]): LaneRollup | undefined {
  return lanes
    .filter((l) => l.weightedDollarsPerPass != null)
    .sort((a, b) => a.weightedDollarsPerPass! - b.weightedDollarsPerPass!)[0];
}
