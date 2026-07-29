// §02 Lane table (sortable) — the detailed row-per-lane view.
// Click a column header to sort. Default: weighted $/pass ascending.
// Winner row (lowest weighted) is highlighted.

import { computeLaneRollups, rankLanes, type LaneRollup, type RunData } from '../data.js';
import { escapeHtml } from '../template.js';
import { fmtDollars } from '../../lib/fmt.js';

export function renderLaneTable(data: RunData): string {
  const lanes = computeLaneRollups(data);
  const ranks = rankLanes(lanes);
  const winnerLane = ranks.bestValue?.laneKey;

  // Sort default: weighted asc, then raw asc, then no-pass rows at bottom.
  const sorted = [...lanes].sort((a, b) => {
    const aw = a.weightedDollarsPerPass, bw = b.weightedDollarsPerPass;
    if (aw != null && bw != null) return aw - bw;
    if (aw != null) return -1;
    if (bw != null) return 1;
    const ar = a.dollarsPerPass, br = b.dollarsPerPass;
    if (ar != null && br != null) return ar - br;
    if (ar != null) return -1;
    if (br != null) return 1;
    return 0;
  });

  const rows = sorted.map((l) => renderRow(l, l.laneKey === winnerLane)).join('');

  return `
<section id="s2">
  <h2><span class="sec-num">02</span>Lane table</h2>
  <details class="explain">
    <summary>What each column means</summary>
    <div class="explain-body">
      <dl>
        <dt>Lane</dt><dd>Destination slug: <code>&lt;router&gt;:&lt;provider&gt;</code>. Same weights served through different routers = different lanes.</dd>
        <dt>Model</dt><dd>The model being tested. Constant across lanes for single-model runs.</dd>
        <dt>Rtr</dt><dd>Router (colored badge): OpenRouter / direct / Vercel / Cloudflare.</dd>
        <dt>Pass</dt><dd><code>passed / attempted</code> for this lane.</dd>
        <dt>\$/pass</dt><dd>Raw cost per pass: <code>total spend / passed count</code>. Ignores trajectory quality.</dd>
        <dt>Judge</dt><dd>Average judge score (0-100) across this lane's sessions — composite of action + grounding + verification + efficiency, computed by the judge LLM after each session. <code>⚠</code> on scores &lt; 50 (usually means "test passed but the model didn't really do the work"; see §4.5 of the SPEC for the caveat around workloads that don't exercise tool_calls).</dd>
        <dt>Weighted \$/pass</dt><dd>The primary metric: <code>\$/pass ÷ (judge score / 100)</code>. Penalises narrated passes. Default sort ascending.</dd>
        <dt>p50 / p95 lat.</dt><dd>Per-step latency percentiles across the lane. Wide spread = long-tail or timeouts.</dd>
      </dl>
      <p style="margin-top: 10px;">Click any column header to sort. Green row = winner (lowest weighted \$/pass).</p>
    </div>
  </details>
  <div class="lb-wrap">
    <table class="lb">
      <thead>
        <tr>
          <th class="sortable" data-sort-key="lane">Lane</th>
          <th class="sortable" data-sort-key="model">Model</th>
          <th class="sortable" data-sort-key="router">Rtr</th>
          <th class="sortable" data-sort-key="pass" style="text-align: right;">Pass</th>
          <th class="sortable sort-desc" data-sort-key="cost_per_pass" style="text-align: right;">\$/pass</th>
          <th class="sortable" data-sort-key="traj" style="text-align: right;">Judge</th>
          <th class="sortable sort-asc" data-sort-key="weighted" style="text-align: right;">Weighted \$/pass</th>
          <th class="sortable" data-sort-key="p50" style="text-align: right;">p50 lat.</th>
          <th class="sortable" data-sort-key="p95" style="text-align: right;">p95 lat.</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`;
}

function renderRow(l: LaneRollup, isWinner: boolean): string {
  const cls: string[] = [];
  if (isWinner) cls.push('winner');
  if (l.passed === 0) cls.push('no-pass');
  const dot = laneDot(l.modelSlug);
  const router = l.router || 'openrouter';
  const trajNum = l.avgTraj;
  const trajWarn = trajNum != null && trajNum < 50;
  return `
    <tr class="${cls.join(' ')}">
      <td class="lane" data-sort-key="lane" data-sort-value="${escapeHtml(l.destSlug)}">
        <span class="dot" style="background: ${dot};"></span>${escapeHtml(l.destSlug)}
      </td>
      <td class="mono" data-sort-key="model" data-sort-value="${escapeHtml(l.modelSlug)}">${escapeHtml(l.modelSlug)}</td>
      <td data-sort-key="router" data-sort-value="${escapeHtml(router)}">
        <span class="router-badge ${escapeHtml(router)}">${escapeHtml(shortRouter(router))}</span>
      </td>
      <td data-sort-key="pass" data-sort-value="${l.attempted > 0 ? l.passed / l.attempted : 0}" style="text-align: right;">${l.passed}/${l.attempted}</td>
      <td data-sort-key="cost_per_pass" data-sort-value="${l.dollarsPerPass ?? ''}" class="mono" style="text-align: right;">${l.dollarsPerPass != null ? escapeHtml(fmtDollars(l.dollarsPerPass)) : '—'}</td>
      <td data-sort-key="traj" data-sort-value="${l.avgTraj ?? ''}" class="mono" style="text-align: right;">
        ${trajNum != null ? escapeHtml(String(trajNum)) : '—'}${trajWarn ? '<span class="traj-warn">⚠</span>' : ''}
      </td>
      <td data-sort-key="weighted" data-sort-value="${l.weightedDollarsPerPass ?? ''}" class="mono" style="text-align: right;">${l.weightedDollarsPerPass != null ? `<strong>${escapeHtml(fmtDollars(l.weightedDollarsPerPass))}</strong>` : '—'}</td>
      <td data-sort-key="p50" data-sort-value="${l.p50LatencyMs ?? ''}" class="mono" style="text-align: right;">${l.p50LatencyMs != null ? `${Math.round(l.p50LatencyMs)}ms` : '—'}</td>
      <td data-sort-key="p95" data-sort-value="${l.p95LatencyMs ?? ''}" class="mono" style="text-align: right;">${l.p95LatencyMs != null ? `${Math.round(l.p95LatencyMs)}ms` : '—'}</td>
    </tr>`;
}

function laneDot(modelSlug: string): string {
  const family = modelSlug.split('/')[0]?.toLowerCase() ?? 'other';
  const map: Record<string, string> = {
    anthropic: '#D97757', openai: '#a855f7', google: '#4ade80',
    deepseek: '#00B7B5', moonshot: '#e879f9', moonshotai: '#e879f9',
    xai: '#94a3b8', meta: '#94a3b8', qwen: '#94a3b8', mistral: '#94a3b8',
    cohere: '#94a3b8', 'z-ai': '#94a3b8',
  };
  return map[family] ?? '#64748b';
}

function shortRouter(r: string): string {
  if (r === 'openrouter') return 'OR';
  if (r === 'direct') return 'DIR';
  if (r === 'vercel') return 'VRC';
  if (r === 'cloudflare') return 'CF';
  return r.slice(0, 4).toUpperCase();
}
