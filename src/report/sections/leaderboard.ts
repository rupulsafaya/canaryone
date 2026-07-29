// §01 Leaderboard — 4 headline cards.
// Big-number-first summary before the detailed lane table.

import { computeLaneRollups, rankLanes, type RunData } from '../data.js';
import { escapeHtml } from '../template.js';
import { fmtDollars } from '../../lib/fmt.js';

export function renderLeaderboard(data: RunData): string {
  const lanes = computeLaneRollups(data);
  const ranks = rankLanes(lanes);
  const totalSpend = lanes.reduce((a, l) => a + l.spend, 0);
  const totalPassed = lanes.reduce((a, l) => a + l.passed, 0);
  const totalAttempted = lanes.reduce((a, l) => a + l.attempted, 0);

  // Spread (weighted): best-value / most-expensive as a multiplier
  const spread = (ranks.bestValue?.weightedDollarsPerPass != null
    && ranks.mostExpensive?.weightedDollarsPerPass != null
    && ranks.bestValue.weightedDollarsPerPass > 0)
    ? ranks.mostExpensive.weightedDollarsPerPass / ranks.bestValue.weightedDollarsPerPass
    : null;

  const cards: Array<{ label: string; num: string; lane?: string; detail: string; primary?: boolean }> = [];

  if (ranks.bestValue) {
    cards.push({
      label: 'Best value',
      num: fmtDollars(ranks.bestValue.weightedDollarsPerPass!),
      lane: ranks.bestValue.destSlug,
      detail: `weighted \$/pass · judge ${ranks.bestValue.avgTraj ?? '—'}`,
      primary: true,
    });
  } else {
    cards.push({ label: 'Best value', num: '—', detail: 'no lane has weighted metric' });
  }

  if (ranks.cheapestRaw) {
    const warned = ranks.cheapestRaw.avgTraj != null && ranks.cheapestRaw.avgTraj < 50;
    cards.push({
      label: 'Cheapest raw',
      num: fmtDollars(ranks.cheapestRaw.dollarsPerPass!),
      lane: ranks.cheapestRaw.destSlug,
      detail: warned
        ? `raw \$/pass · judge ${ranks.cheapestRaw.avgTraj} ⚠ narrated`
        : `raw \$/pass · judge ${ranks.cheapestRaw.avgTraj ?? '—'}`,
    });
  } else {
    cards.push({ label: 'Cheapest raw', num: '—', detail: 'no passing lane' });
  }

  cards.push({
    label: 'Pass rate',
    num: `${totalPassed}/${totalAttempted}`,
    detail: totalAttempted > 0
      ? `${Math.round((totalPassed / totalAttempted) * 100)}% across all sessions`
      : 'no sessions',
  });

  cards.push({
    label: 'Total spend',
    num: fmtDollars(totalSpend),
    detail: spread != null ? `${spread.toFixed(1)}× spread (weighted)` : 'across all lanes',
  });

  const cardHtml = cards.map((c) => `
    <div class="headline${c.primary ? ' primary' : ''}">
      <div class="headline-label">${escapeHtml(c.label)}</div>
      <div class="headline-num">${escapeHtml(c.num)}</div>
      ${c.lane ? `<div class="headline-lane">${escapeHtml(c.lane)}</div>` : ''}
      <div class="headline-detail">${escapeHtml(c.detail)}</div>
    </div>`).join('');

  return `
<section id="s1">
  <h2><span class="sec-num">01</span>Leaderboard</h2>
  <details class="explain">
    <summary>How to read this</summary>
    <div class="explain-body">
      <p>Four headline cards summarising the run. <strong>Best value</strong> is the lane with the lowest <code>weighted \$/pass</code> among those with ≥1 pass — the primary metric. <strong>Cheapest raw</strong> ignores trajectory quality; if its traj is &lt; 50 it carries a ⚠ narrated flag (interpret with §4.5 heuristic). <strong>Pass rate</strong> is total sessions passed across all lanes. <strong>Spread</strong> is <code>most-expensive weighted / best-value weighted</code> — how far apart the extremes are on identical work.</p>
    </div>
  </details>
  <div class="headlines">${cardHtml}</div>
</section>`;
}
