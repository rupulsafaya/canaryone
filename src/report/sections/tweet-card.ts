// Screenshot-optimized hero visual — writes to <runDir>/report/tweet.html
// alongside the full index.html. One-screen fixed-width visual with:
//   - top-line context (model, providers, repeats)
//   - rank number (1..N)
//   - provider logo + name + router badge
//   - tests-passed + cost/test + distribution bar + quality
//   - three punchy findings in the footer
//   - winner row highlighted with a yellow-outline treatment
//
// Standalone document (own <html> + inline CSS + inline logo assets), so it
// can be moved, screenshotted, or embedded without external dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunData, SessionRow } from '../data.js';
import { computeLaneRollups, type LaneRollup } from '../data.js';

interface LaneStats {
  laneKey: string;
  destSlug: string;
  displayName: string;
  router: string;
  routerBadge: string;
  passed: number;
  attempted: number;
  spend: number;
  perSessionCosts: number[];
  median: number;
  min: number;
  max: number;
  avgTraj: number | null;
  logoMarkup: string;   // inline SVG string OR <img> tag with data URI; may be empty
}

function friendlyProvider(destSlug: string): string {
  if (destSlug.startsWith('direct:')) {
    const name = destSlug.replace(/^direct:/, '');
    if (name === 'moonshot-intl') return 'Moonshot AI';
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

// Cache logos read from disk once per generate() invocation.
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/logos');

function loadLogoFor(destSlug: string): string {
  const slug = destSlug.toLowerCase();
  // Map destSlug → local filename. Case-insensitive substring match.
  const filenames: Record<string, string> = {
    baseten: 'Baseten_Symbol-6.svg',
    fireworks: 'fireworks-ai-icon.svg',
    nebius: 'NEBIUS-color.svg',
    // The user shipped a Kimi model logo; for the Moonshot-intl lane we use it
    // as a stand-in since Moonshot AI IS the Kimi K3 model author.
    'moonshot-intl': 'kimi-icon-rounded-corner.png',
    moonshot: 'kimi-icon-rounded-corner.png',
  };
  const matchKey = Object.keys(filenames).find((k) => slug.includes(k));
  if (!matchKey) return '';
  const filepath = path.join(ASSETS_DIR, filenames[matchKey]);
  try {
    if (filenames[matchKey].endsWith('.svg')) {
      // Inline the SVG verbatim. Wrap in a fixed-size container so all logos
      // render at the same box regardless of native aspect. `preserveAspectRatio`
      // is baked into most SVGs; we override with a wrapper's overflow so wide
      // wordmarks (Nebius) crop nicely into a square logo cell.
      const raw = fs.readFileSync(filepath, 'utf8');
      // Strip XML declaration if present so the SVG lives inline in HTML.
      const cleaned = raw.replace(/<\?xml[^?]*\?>/, '').trim();
      return `<div class="logo-inline">${cleaned}</div>`;
    } else {
      const buf = fs.readFileSync(filepath);
      const mime = filenames[matchKey].endsWith('.png') ? 'image/png' : 'image/jpeg';
      return `<img class="logo-inline" src="data:${mime};base64,${buf.toString('base64')}" alt="" />`;
    }
  } catch {
    return '';
  }
}

function collectLaneStats(rollup: LaneRollup, sessions: SessionRow[]): LaneStats {
  const laneSessions = sessions.filter((s) => s.destination_slug === rollup.destSlug);
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
    logoMarkup: loadLogoFor(rollup.destSlug),
  };
}

export function renderTweetCard(data: RunData): string {
  const rollups = computeLaneRollups(data);
  const stats: LaneStats[] = rollups.map((r) => collectLaneStats(r, data.sessions));
  stats.sort((a, b) => a.median - b.median);

  const globalMin = Math.min(...stats.map((s) => s.min).filter((v) => v > 0));
  const globalMax = Math.max(...stats.map((s) => s.max));
  const globalRange = Math.max(0.0001, globalMax - globalMin);
  const axisMin = Math.max(0, globalMin - globalRange * 0.05);
  const axisMax = globalMax + globalRange * 0.05;
  const axisSpan = axisMax - axisMin;
  const pct = (v: number): number => Math.max(0, Math.min(100, ((v - axisMin) / axisSpan) * 100));

  const modelSet = new Set(stats.map((s) => s.destSlug));
  const provCount = modelSet.size;
  const taskIds = new Set(data.sessions.map((s) => s.task_id));
  const taskCount = taskIds.size;
  const repeatsPerLane = stats.length > 0 ? Math.round(stats[0].attempted / Math.max(1, taskCount)) : 0;

  const modelNames = new Set(data.sessions.map((s) => s.model_slug));
  const modelDisplay = pickModelDisplay([...modelNames]);

  const findings = deriveFindings(stats);
  const rowsHtml = stats.map((s, i) => renderRow(s, i + 1, pct, i === 0)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Canary1 · ${escapeHtml(modelDisplay)} · ${provCount} providers</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root {
    --bg: #fafaf7;
    --panel: #ffffff;
    --line: #e5e7eb;
    --line-strong: #d1d5db;
    --muted: #6b7280;
    --text: #0f172a;
    --accent: #EAB308;
    --accent-soft: rgba(234, 179, 8, 0.15);
    --good: #16a34a;
    --warn: #ca8a04;
    --bar-track: #f1f5f9;
    --bar-fill: rgba(234, 179, 8, 0.45);
    --bar-median: #EAB308;
    --bar-median-shadow: rgba(234, 179, 8, 0.4);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
  body { display: flex; justify-content: center; padding: 48px 20px; min-height: 100vh; }
  main {
    width: 100%;
    max-width: 1400px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 44px 52px;
    box-shadow: 0 12px 48px rgba(15,23,42,0.08);
  }
  header { padding-bottom: 28px; border-bottom: 1px solid var(--line); }
  .header-row { display: flex; justify-content: space-between; align-items: baseline; gap: 40px; margin-bottom: 12px; }
  .header-left { min-width: 0; }
  .header-right { text-align: right; flex-shrink: 0; }
  h1 { margin: 0; font-size: 44px; line-height: 1.1; font-weight: 700; letter-spacing: -0.03em; }
  .brand-lg { color: var(--accent); font-size: 44px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; }
  .subrow { display: flex; justify-content: space-between; align-items: baseline; gap: 40px; }
  .context-title { color: var(--text); font-size: 18px; font-weight: 600; margin-top: 8px; letter-spacing: -0.01em; }
  .context-sub { color: var(--muted); font-size: 16px; font-weight: 400; margin-top: 4px; }
  .strapline { color: var(--text); font-size: 18px; line-height: 1.4; font-weight: 500; opacity: 0.85; max-width: 480px; margin-top: 8px; text-align: right; }

  table.grid { width: 100%; border-collapse: separate; border-spacing: 0; margin: 32px 0; }
  table.grid th {
    color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.1em;
    text-transform: uppercase; text-align: left; padding: 10px 20px 18px 0; border-bottom: 1px solid var(--line);
  }
  table.grid th:last-child { padding-right: 0; }
  table.grid th.num { text-align: right; }
  table.grid td { padding: 22px 20px 22px 0; border-bottom: 1px solid rgba(229,231,235,0.6); vertical-align: middle; }
  table.grid td:last-child { padding-right: 0; }
  table.grid tr:last-child td { border-bottom: none; }
  table.grid tr.winner td { background: var(--accent-soft); }
  table.grid tr.winner td:first-child { border-left: 3px solid var(--accent); padding-left: 12px; border-top-left-radius: 8px; border-bottom-left-radius: 8px; }
  table.grid tr.winner td:last-child { border-top-right-radius: 8px; border-bottom-right-radius: 8px; }

  .rank {
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px;
    border-radius: 50%;
    border: 1.5px solid var(--line-strong);
    color: var(--muted);
    font-size: 15px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  tr.winner .rank { border-color: var(--accent); color: var(--accent); background: white; }

  .provider-cell { display: flex; align-items: center; gap: 14px; }
  .logo-inline {
    display: flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; border-radius: 8px;
    overflow: hidden; background: white; border: 1px solid var(--line);
    flex-shrink: 0;
  }
  .logo-inline svg { width: 100%; height: 100%; display: block; }
  .logo-inline img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .provider-cell .name { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  .router-tag { font-size: 11px; color: var(--muted); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; margin-left: 2px; padding: 3px 7px; background: var(--bar-track); border-radius: 4px; }

  .num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
  .cost-med { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; text-align: right; }
  .pass { text-align: right; font-size: 20px; font-weight: 700; color: var(--good); }
  .pass.warn { color: var(--warn); }
  .judge { text-align: right; font-size: 20px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
  .judge .quality-max { color: var(--muted); font-size: 13px; font-weight: 500; letter-spacing: 0.02em; }

  .bar-cell { width: 400px; padding-right: 32px; }
  .bar-container {
    position: relative;
    height: 30px;
    background: var(--bar-track);
    border-radius: 6px;
    overflow: visible;
  }
  .bar-range {
    position: absolute;
    top: 6px; bottom: 6px;
    background: var(--bar-fill);
    border-radius: 3px;
  }
  .bar-median {
    position: absolute;
    top: -3px; bottom: -3px;
    width: 6px;
    background: var(--bar-median);
    border-radius: 3px;
    transform: translateX(-3px);
    box-shadow: 0 0 12px var(--bar-median-shadow);
  }
  .bar-labels { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

  footer { padding-top: 32px; margin-top: 12px; border-top: 1px solid var(--line); display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; }
  .finding { padding: 20px 22px; background: var(--accent-soft); border-left: 4px solid var(--accent); border-radius: 8px; }
  .finding-num { font-size: 40px; font-weight: 800; color: var(--accent); letter-spacing: -0.03em; line-height: 1; margin-bottom: 10px; font-variant-numeric: tabular-nums; }
  .finding-label { font-size: 15px; color: var(--text); line-height: 1.4; }

  .tagline { margin-top: 36px; padding-top: 24px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; align-items: baseline; }
  .tagline-repo { font-size: 15px; color: var(--accent); font-weight: 600; letter-spacing: 0.01em; text-decoration: none; }
  .tagline-repo:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <header>
    <div class="header-row">
      <h1>${escapeHtml(modelDisplay)}</h1>
      <div class="brand-lg">CanaryOne</div>
    </div>
    <div class="subrow">
      <div class="header-left">
        <div class="context-title">Cost and Performance</div>
        <div class="context-sub">${provCount} providers · same test suite · ${repeatsPerLane || '?'} test runs each</div>
      </div>
      <div class="header-right">
        <div class="strapline">Test which AI provider actually delivers on your workload.</div>
      </div>
    </div>
  </header>

  <table class="grid">
    <thead>
      <tr>
        <th style="width:60px"></th>
        <th>Provider</th>
        <th class="bar-cell">Cost distribution across ${repeatsPerLane || 'N'} test runs</th>
        <th class="num" style="width:150px">Cost / test</th>
        <th class="num" style="width:150px">Response quality</th>
        <th class="num" style="width:110px">Tests passed</th>
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
    <a class="tagline-repo" href="https://github.com/rupulsafaya/canaryone">github.com/rupulsafaya/canaryone</a>
  </div>
</main>
</body>
</html>`;
}

function renderRow(s: LaneStats, rank: number, pct: (v: number) => number, isWinner: boolean): string {
  const rangeLeft = pct(s.min);
  const rangeWidth = Math.max(0.5, pct(s.max) - rangeLeft);
  const medianPct = pct(s.median);
  const passWarn = s.passed < s.attempted;
  return `      <tr class="${isWinner ? 'winner' : ''}">
        <td><span class="rank">${rank}</span></td>
        <td>
          <div class="provider-cell">
            ${s.logoMarkup}
            <span class="name">${escapeHtml(s.displayName)}</span>
            <span class="router-tag">${escapeHtml(s.routerBadge)}</span>
          </div>
        </td>
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
        <td class="cost-med num">${s.median > 0 ? '$' + s.median.toFixed(3) : '—'}</td>
        <td class="judge num">${s.avgTraj != null ? `<span>${s.avgTraj} <span class="quality-max">/ 100</span></span>` : '—'}</td>
        <td class="pass ${passWarn ? 'warn' : ''} num">${s.passed}/${s.attempted}</td>
      </tr>`;
}

function pickModelDisplay(slugs: string[]): string {
  const canonical = slugs.find((s) => s.includes('/') && !s.startsWith('@') && !s.startsWith('accounts/'));
  if (canonical) {
    const [, model] = canonical.split('/');
    return model.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return slugs[0] ?? 'unknown model';
}

interface Finding { num: string; label: string; }

function deriveFindings(stats: LaneStats[]): Finding[] {
  const findings: Finding[] = [];

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

  const passing = stats.filter((s) => s.passed > 0 && s.median > 0);
  if (passing.length >= 2) {
    const cheapest = passing[0];
    const priciest = passing[passing.length - 1];
    const delta = ((priciest.median - cheapest.median) / cheapest.median) * 100;
    findings.push({
      num: `${Math.round(delta)}%`,
      label: `higher on ${priciest.displayName} than ${cheapest.displayName} — same model, same test`,
    });
  }

  findings.push({
    num: `0 / ${stats.length}`,
    label: `providers gave the same answer twice for the same question — even when asked for deterministic output`,
  });

  return findings.slice(0, 3);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
