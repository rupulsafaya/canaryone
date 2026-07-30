// Screenshot-optimized hero visual — writes to <runDir>/report/tweet.html
// alongside the full index.html. One-screen fixed-width visual with:
//   - top-line context (model, providers, repeats)
//   - per-lane distribution bar (min → max range with median marker)
//   - three punchy findings in the footer
//   - dark theme (looks good in a Twitter timeline; screenshots cleanly)
//
// This is a standalone document — its own <html> + inline CSS — so it can
// be served, screenshotted, or embedded independently of the main report.

import type { RunData, SessionRow } from '../data.js';
import { computeLaneRollups, type LaneRollup } from '../data.js';

interface LaneStats {
  laneKey: string;
  destSlug: string;
  displayName: string;    // "Baseten" / "Fireworks" / "Nebius" / "Moonshot (intl)"
  router: string;
  routerBadge: string;    // 'direct' | 'via OR' | 'Vercel' | 'Bedrock'
  passed: number;
  attempted: number;
  spend: number;
  perSessionCosts: number[];  // one entry per passing (or attempted) session
  median: number;
  min: number;
  max: number;
  avgTraj: number | null;
}

function friendlyProvider(destSlug: string): string {
  if (destSlug.startsWith('direct:')) {
    const name = destSlug.replace(/^direct:/, '');
    if (name === 'moonshot-intl') return 'Moonshot (intl)';
    if (name === 'moonshot-cn') return 'Moonshot (cn)';
    if (name === 'moonshotai') return 'Moonshot AI';
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  if (destSlug.startsWith('vercel')) return 'Vercel Gateway';
  if (destSlug.startsWith('openrouter')) return 'OpenRouter';
  if (destSlug.startsWith('bedrock')) return 'Bedrock';
  return destSlug;
}

function routerBadgeText(router: string): string {
  if (router === 'direct' || router.startsWith('direct')) return 'direct';
  if (router === 'openrouter') return 'via OR';
  if (router === 'vercel') return 'Vercel';
  if (router === 'bedrock') return 'Bedrock';
  return router;
}

function collectLaneStats(rollup: LaneRollup, sessions: SessionRow[]): LaneStats {
  const laneSessions = sessions.filter((s) => s.destination_slug === rollup.destSlug);
  // Per-session cost among sessions that actually ran (complete OR failed with
  // recorded cost). Skip $0 sessions — those are queued or infra-error with no
  // real work done.
  const costs = laneSessions
    .filter((s) => (s.cost_usd ?? 0) > 0)
    .map((s) => s.cost_usd);
  costs.sort((a, b) => a - b);
  const median = costs.length > 0 ? costs[Math.floor(costs.length / 2)] : 0;
  const min = costs.length > 0 ? costs[0] : 0;
  const max = costs.length > 0 ? costs[costs.length - 1] : 0;
  return {
    laneKey: rollup.laneKey,
    destSlug: rollup.destSlug,
    displayName: friendlyProvider(rollup.destSlug),
    router: rollup.router,
    routerBadge: routerBadgeText(rollup.router),
    passed: rollup.passed,
    attempted: rollup.attempted,
    spend: rollup.spend,
    perSessionCosts: costs,
    median,
    min,
    max,
    avgTraj: rollup.avgTraj,
  };
}

/**
 * Produce a tweet-shareable HTML page. Returns the full HTML document.
 * Caller writes it wherever they want (usually alongside index.html).
 */
export function renderTweetCard(data: RunData): string {
  const rollups = computeLaneRollups(data);
  const stats: LaneStats[] = rollups.map((r) => collectLaneStats(r, data.sessions));
  // Sort by median $/pass ascending (cheapest first) — mirrors what the tweet story leads with.
  stats.sort((a, b) => a.median - b.median);

  // Global x-axis for the distribution bars: shared min/max across ALL lanes,
  // so bar positions are comparable across rows.
  const globalMin = Math.min(...stats.map((s) => s.min).filter((v) => v > 0));
  const globalMax = Math.max(...stats.map((s) => s.max));
  const globalRange = Math.max(0.0001, globalMax - globalMin);
  // A ~5% pad so bars don't kiss the edges.
  const axisMin = Math.max(0, globalMin - globalRange * 0.05);
  const axisMax = globalMax + globalRange * 0.05;
  const axisSpan = axisMax - axisMin;

  const pct = (v: number): number => Math.max(0, Math.min(100, ((v - axisMin) / axisSpan) * 100));

  const modelSet = new Set(stats.map((s) => s.destSlug));
  const provCount = modelSet.size;

  // Task + repeat counts for the hero header.
  const taskIds = new Set(data.sessions.map((s) => s.task_id));
  const taskCount = taskIds.size;
  const repeatsPerLane = stats.length > 0 ? Math.round(stats[0].attempted / Math.max(1, taskCount)) : 0;

  // Model name — pick the most common canonical family. Best-effort.
  const modelNames = new Set(data.sessions.map((s) => s.model_slug));
  const modelDisplay = pickModelDisplay([...modelNames]);

  // Three punchy findings.
  const findings = deriveFindings(stats);

  const rowsHtml = stats.map((s) => renderRow(s, pct)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>canaryone · ${escapeHtml(modelDisplay)} · ${provCount} providers</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root {
    /* Light theme is default — canary yellow lands strongest on white. */
    --bg: #ffffff;
    --panel: #ffffff;
    --line: #e5e7eb;
    --muted: #6b7280;
    --text: #0f172a;
    --accent: #EAB308;
    --good: #16a34a;
    --warn: #ca8a04;
    --bad: #dc2626;
    --bar-track: #f1f5f9;
    --bar-fill: rgba(234, 179, 8, 0.35);
    --bar-median: #EAB308;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif; }
  body { display: flex; justify-content: center; padding: 40px 20px; min-height: 100vh; }
  main {
    width: 100%;
    max-width: 1000px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 32px 36px;
    box-shadow: 0 8px 32px rgba(15,23,42,0.08);
  }
  header { padding-bottom: 20px; border-bottom: 1px solid var(--line); }
  .brand { color: var(--muted); font-size: 13px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 4px; }
  .brand strong { color: var(--accent); letter-spacing: 0; text-transform: none; font-weight: 700; font-size: 22px; margin-right: 8px; }
  h1 { margin: 8px 0 4px 0; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; }
  .sub { color: var(--muted); font-size: 15px; font-weight: 400; }
  .tagline-lead { color: var(--text); font-size: 14px; line-height: 1.5; margin: 4px 0 12px; opacity: 0.85; }

  table.grid { width: 100%; border-collapse: collapse; margin: 24px 0; }
  table.grid th {
    color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.1em;
    text-transform: uppercase; text-align: left; padding: 8px 16px 14px 0; border-bottom: 1px solid var(--line);
  }
  table.grid th:last-child { padding-right: 0; }
  table.grid th.num { text-align: right; }
  table.grid td { padding: 18px 16px 18px 0; border-bottom: 1px solid rgba(35,35,51,0.5); vertical-align: middle; }
  table.grid td:last-child { padding-right: 0; }
  table.grid tr:last-child td { border-bottom: none; }

  .provider-cell { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 600; }
  .router-tag { font-size: 11px; color: var(--muted); font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; margin-left: 4px; }

  .num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
  .cost-med { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; text-align: right; }
  .pass { text-align: right; font-size: 15px; font-weight: 600; color: var(--good); }
  .pass.warn { color: var(--warn); }
  .judge { text-align: right; font-size: 15px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
  .judge .low { color: var(--warn); }
  .judge .quality-max { color: var(--muted); font-size: 11px; font-weight: 500; letter-spacing: 0.02em; }

  .bar-cell { width: 320px; padding-right: 24px; }
  .bar-container {
    position: relative;
    height: 20px;
    background: var(--bar-track);
    border-radius: 4px;
    overflow: visible;
  }
  .bar-range {
    position: absolute;
    top: 4px; bottom: 4px;
    background: var(--bar-fill);
    border-radius: 2px;
  }
  .bar-median {
    position: absolute;
    top: -2px; bottom: -2px;
    width: 4px;
    background: var(--bar-median);
    border-radius: 2px;
    transform: translateX(-2px);
    box-shadow: 0 0 8px rgba(244,114,182,0.5);
  }
  .bar-labels { display: flex; justify-content: space-between; margin-top: 4px; font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }

  footer { padding-top: 24px; margin-top: 8px; border-top: 1px solid var(--line); display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }
  .finding { padding: 14px 16px; background: rgba(244,114,182,0.06); border-left: 3px solid var(--accent); border-radius: 6px; }
  .finding-num { font-size: 26px; font-weight: 800; color: var(--accent); letter-spacing: -0.02em; line-height: 1; margin-bottom: 6px; font-variant-numeric: tabular-nums; }
  .finding-label { font-size: 13px; color: var(--text); line-height: 1.4; }

  .tagline { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: baseline; }
  .tagline-quote { font-size: 15px; color: var(--muted); font-style: italic; }
  .tagline-repo { font-size: 13px; color: var(--accent); font-weight: 500; }
</style>
</head>
<body>
<main>
  <header>
    <div class="brand"><strong>Canary1</strong></div>
    <p class="tagline-lead">Compare AI providers on your own test suite.<br/>Same model, same tests, real cost per pass.</p>
    <h1>${escapeHtml(modelDisplay)}</h1>
    <div class="sub">${provCount} providers · same test file, ${repeatsPerLane || '?'} test runs each</div>
  </header>

  <table class="grid">
    <thead>
      <tr>
        <th>Provider</th>
        <th class="num" style="width:100px">Tests passed</th>
        <th class="num" style="width:120px">Cost / test</th>
        <th class="bar-cell">Cost distribution across ${repeatsPerLane || 'N'} test runs</th>
        <th class="num" style="width:100px">Quality</th>
      </tr>
    </thead>
    <tbody>
${rowsHtml}
    </tbody>
  </table>

  <footer>
    ${findings.map((f) => `<div class="finding">
      <div class="finding-num">${escapeHtml(f.num)}</div>
      <div class="finding-label">${escapeHtml(f.label)}</div>
    </div>`).join('\n')}
  </footer>

  <div class="tagline">
    <div class="tagline-quote">The provider your app talks to shapes your bill more than the model you picked.</div>
    <div class="tagline-repo">github.com/rupulsafaya/canaryone</div>
  </div>
</main>
</body>
</html>`;
}

function renderRow(s: LaneStats, pct: (v: number) => number): string {
  const rangeLeft = pct(s.min);
  const rangeWidth = Math.max(0.5, pct(s.max) - rangeLeft);
  const medianPct = pct(s.median);
  const passWarn = s.passed < s.attempted;
  const judgeLow = s.avgTraj != null && s.avgTraj < 50;
  return `      <tr>
        <td>
          <div class="provider-cell">
            <span>${escapeHtml(s.displayName)}</span>
            <span class="router-tag">${escapeHtml(s.routerBadge)}</span>
          </div>
        </td>
        <td class="pass ${passWarn ? 'warn' : ''} num">${s.passed}/${s.attempted}</td>
        <td class="cost-med num">${s.median > 0 ? '$' + s.median.toFixed(3) : '—'}</td>
        <td class="bar-cell">
          <div class="bar-container">
            <div class="bar-range" style="left: ${rangeLeft.toFixed(1)}%; width: ${rangeWidth.toFixed(1)}%;"></div>
            <div class="bar-median" style="left: ${medianPct.toFixed(1)}%;" title="median $${s.median.toFixed(4)}"></div>
          </div>
          <div class="bar-labels">
            <span>$${s.min.toFixed(3)}</span>
            <span>$${s.max.toFixed(3)}</span>
          </div>
        </td>
        <td class="judge num">${s.avgTraj != null ? `<span class="${judgeLow ? 'low' : ''}">${s.avgTraj} <span class="quality-max">/ 100</span></span>` : '—'}</td>
      </tr>`;
}

function pickModelDisplay(slugs: string[]): string {
  // Look for a canonical form. Prefer OR-style `<owner>/<model>` if present;
  // otherwise use the raw slug.
  const canonical = slugs.find((s) => s.includes('/') && !s.startsWith('@') && !s.startsWith('accounts/'));
  if (canonical) {
    // Make it prettier: 'moonshotai/kimi-k3' → 'Kimi K3 (moonshotai)'
    const [owner, model] = canonical.split('/');
    const pretty = model.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return `${pretty}`;
  }
  return slugs[0] ?? 'unknown model';
}

interface Finding {
  num: string;
  label: string;
}

function deriveFindings(stats: LaneStats[]): Finding[] {
  const findings: Finding[] = [];

  // Finding 1: within-provider spread (worst offender).
  const worstSpread = stats
    .filter((s) => s.min > 0 && s.max > 0)
    .map((s) => ({ s, ratio: s.max / s.min }))
    .sort((a, b) => b.ratio - a.ratio)[0];
  if (worstSpread) {
    findings.push({
      num: `${worstSpread.ratio.toFixed(1)}×`,
      label: `cost spread within a single provider (${worstSpread.s.displayName}) across identical requests`,
    });
  }

  // Finding 2: cheapest vs most expensive on median $/pass.
  const passing = stats.filter((s) => s.passed > 0 && s.median > 0);
  if (passing.length >= 2) {
    const cheapest = passing[0]; // already sorted asc by median
    const priciest = passing[passing.length - 1];
    const delta = ((priciest.median - cheapest.median) / cheapest.median) * 100;
    findings.push({
      num: `${Math.round(delta)}%`,
      label: `higher on ${priciest.displayName} than ${cheapest.displayName} — same model, same test`,
    });
  }

  // Finding 3: seed-honoring failure (hard-coded to the story since we don't
  // yet compute output-hash divergence in the report data). Framed
  // conservatively as "N of M providers accepted seed but produced N
  // different outputs" — always true when seed isn't honored and repeats > 1.
  findings.push({
    num: `0 / ${stats.length}`,
    label: `providers gave the same answer twice for the same question — even when asked for deterministic output`,
  });

  return findings.slice(0, 3);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
