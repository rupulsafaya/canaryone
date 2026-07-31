// Next-generation canaryone report — canaryone-brand aesthetic
// (cream background + canary accent + monospace-heavy chrome).
//
// Written to `.c1/runs/<runId>/report/report.html` alongside the existing
// `index.html` (which stays untouched). Standalone document (own <html>,
// inline CSS + JS), so it can be moved / screenshotted / emailed without
// external dependencies.
//
// Contains a single section for now — the Pareto cost-vs-quality chart —
// and is the destination file we'll progressively migrate the rest of the
// report into.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { RunData } from './data.js';
import { buildParetoData, type ParetoData } from './pareto.js';

// Brand logos are sourced from @lobehub/icons-static-svg — a 900+ icon
// collection covering every provider + router in the canaryone universe.
// Prefer the "-color" variant when it exists; fall back to the monochrome
// symbol (rendered in black on a white shape background).
//
// Missing entries fall back to a colored router-shape (no logo overlay).

const PROVIDER_LOBE_SLUG: Record<string, string> = {
  baseten:         'baseten',
  fireworks:       'fireworks',
  moonshotai:      'moonshot',
  moonshot:        'moonshot',
  'moonshot-intl': 'moonshot',
  'moonshot-cn':   'moonshot',
  nebius:          'nebius',
  cerebras:        'cerebras',
  deepseek:        'deepseek',
  together:        'together',
  openai:          'openai',
  anthropic:       'anthropic',
  xai:             'xai',
  'x-ai':          'xai',
  google:          'gemini',
  'google-gemini': 'gemini',
  groq:            'groq',
  zai:             'zai',
  'z-ai':          'zai',
};

const ROUTER_LOBE_SLUG: Record<string, string> = {
  openrouter: 'openrouter',
  vercel:     'vercel',
  bedrock:    'bedrock',
};

const requireC = createRequire(import.meta.url);
let LOBE_ICONS_DIR: string | null = null;
try {
  LOBE_ICONS_DIR = path.join(
    path.dirname(requireC.resolve('@lobehub/icons-static-svg/package.json')),
    'icons',
  );
} catch {
  LOBE_ICONS_DIR = null;
}

function loadLobeIcon(iconSlug: string): string | null {
  if (!LOBE_ICONS_DIR) return null;
  for (const suffix of ['-color', '']) {
    const filepath = path.join(LOBE_ICONS_DIR, iconSlug + suffix + '.svg');
    try {
      const raw = fs.readFileSync(filepath);
      return `data:image/svg+xml;base64,${raw.toString('base64')}`;
    } catch { /* try next */ }
  }
  return null;
}

function collectProviderLogos(pdata: ParetoData): Record<string, string> {
  const slugs = new Set<string>();
  for (const dot of pdata.data.all) slugs.add(dot.providerSlug);
  const out: Record<string, string> = {};
  for (const slug of slugs) {
    const lobeSlug = PROVIDER_LOBE_SLUG[slug];
    if (!lobeSlug) continue;
    const uri = loadLobeIcon(lobeSlug);
    if (uri) out[slug] = uri;
  }
  return out;
}

function collectRouterLogos(pdata: ParetoData): Record<string, string> {
  const routers = new Set<string>();
  for (const dot of pdata.data.all) routers.add(dot.router);
  const out: Record<string, string> = {};
  for (const r of routers) {
    const lobeSlug = ROUTER_LOBE_SLUG[r];
    if (!lobeSlug) continue;
    const uri = loadLobeIcon(lobeSlug);
    if (uri) out[r] = uri;
  }
  return out;
}

export function renderNextReport(data: RunData): string {
  const pdata = buildParetoData(data);
  const providerLogos = collectProviderLogos(pdata);
  const routerLogos = collectRouterLogos(pdata);
  const title = `canaryone · ${escapeHtml(pdata.meta.repoName)} · ${escapeHtml(pdata.meta.dateIso)}`;
  const embed = { ...pdata, providerLogos, routerLogos };
  const jsonEmbed = JSON.stringify(embed).replace(/</g, '\\u003c');
  // Only skip if there's literally nothing to draw. One lane still renders
  // (single dot, no frontier line — the JS handles that gracefully).
  const notEnoughData = pdata.data.all.length < 1;

  const metaLine = [
    pdata.meta.shortSha ? `@ ${escapeHtml(pdata.meta.shortSha)}` : '',
    escapeHtml(pdata.meta.dateIso),
    pdata.meta.timeUtc ? `<span class="utc-time">${escapeHtml(pdata.meta.timeUtc)}</span>` : '',
  ].filter(Boolean).join(' · ');

  const chips = pdata.evals.map((e) =>
    `<span class="chip" data-eval="${escapeHtml(e.id)}" data-desc="${escapeHtml(e.summary)}">${escapeHtml(e.id)}</span>`
  ).join('');

  const notEnoughDataNotice = notEnoughData ? `
    <div class="notice">
      Not enough lanes with successful passes to draw a chart
      (need ≥ 2; have ${pdata.data.all.length}).
      Add more lanes and re-run.
    </div>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="generator" content="canaryone next-report (Pareto)">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Performance / Cost Frontier</h1>
    <p class="meta-line">
      <span class="repo">${escapeHtml(pdata.meta.repoName)}</span>
      <span class="sep">·</span>${metaLine}
    </p>
    <p class="subhead" data-subhead>
      <b>${pdata.data.all.length} lane${pdata.data.all.length === 1 ? '' : 's'}</b><span class="sep">·</span>
      <b>${pdata.meta.modelCount} model${pdata.meta.modelCount === 1 ? '' : 's'}</b><span class="sep">·</span>
      <b>${pdata.meta.providerCount} provider${pdata.meta.providerCount === 1 ? '' : 's'}</b><span class="sep">·</span>
      <b>${pdata.meta.routerCount} router${pdata.meta.routerCount === 1 ? '' : 's'}</b><span class="sep">·</span>
      <b>${pdata.meta.evalCount} eval${pdata.meta.evalCount === 1 ? '' : 's'}</b><span class="sep">·</span>
      <b>${pdata.meta.runsPerEvalPerDest} run${pdata.meta.runsPerEvalPerDest === 1 ? '' : 's'} each</b>
    </p>
  </header>

  ${notEnoughDataNotice}

  ${notEnoughData ? '' : `
  <div class="filter-row" id="filter-row">
    <span class="filter-lbl">EVAL SELECTOR</span>
    ${chips}
  </div>
  <p class="eval-desc" id="eval-desc"></p>

  <div class="card">
    <button class="export-btn" type="button" title="Export chart as PNG" aria-label="Export as PNG" id="export-btn">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    </button>

    <svg viewBox="0 0 900 580" width="100%" height="auto" role="img" aria-label="cost vs quality scatter" id="chart-svg" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="attractive-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%"   stop-color="#fef08a" stop-opacity="0.42"/>
          <stop offset="100%" stop-color="#fef08a" stop-opacity="0.08"/>
        </linearGradient>
      </defs>

      <!-- Shareable header band (inside SVG so PNG exports carry it). -->
      <g class="svg-header">
        <!-- Title, top-left -->
        <text x="60" y="34" text-anchor="start" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="20" font-weight="600" fill="#0f172a" letter-spacing="-0.3">Performance / Cost Frontier</text>
        <text x="60" y="58" text-anchor="start" font-family="ui-monospace, Menlo, Monaco, monospace" font-size="11" fill="#6b7280"><tspan fill="#0f172a">${escapeHtml(pdata.meta.repoName)}</tspan>${pdata.meta.shortSha ? ' · @ ' + escapeHtml(pdata.meta.shortSha) : ''} · ${escapeHtml(pdata.meta.dateIso)} · <tspan font-size="9.5">${escapeHtml(pdata.meta.timeUtc)}</tspan></text>

        <!-- Byline, right-aligned to the plot's right edge (dotted-line end at x=860). -->
        <text x="860" y="34" text-anchor="end" font-family="ui-monospace, Menlo, Monaco, monospace" font-size="10.5" fill="#6b7280">Generated by <a href="https://canaryone.ai" target="_blank" rel="noopener"><tspan fill="#0f172a" font-weight="600" text-decoration="underline" style="cursor:pointer">CanaryOne.ai</tspan></a></text>
        <text x="860" y="52" text-anchor="end" font-family="ui-monospace, Menlo, Monaco, monospace" font-size="10.5" fill="#6b7280">Compare AI models and providers <tspan fill="#a16207" font-weight="600">on your workload</tspan></text>

        <!-- Divider under the header band -->
        <line x1="60" y1="78" x2="860" y2="78" stroke="#e5e7eb" stroke-width="1"/>
      </g>

      <g id="chart-static"></g>
      <g id="chart-content"></g>
    </svg>

    <div id="chart-tooltip" class="chart-tooltip" aria-hidden="true"></div>

    <p class="caption" id="caption"></p>
    <div class="chart-legend" id="chart-legend"></div>
  </div>

  <div class="tools-row">
    <label>
      <input type="checkbox" id="dist-toggle" checked>
      show per-repeat distribution
    </label>
  </div>
  `}

</div>

<script id="pareto-data" type="application/json">${jsonEmbed}</script>
${notEnoughData ? '' : `<script>${SCRIPT}</script>`}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Inline styles — canaryone-web brand tokens (cream + canary).
// ---------------------------------------------------------------------------

const STYLES = `
:root {
  --bg: #fafaf7;
  --bg-tint: #f5f2e8;
  --panel: #ffffff;
  --dark: #0f0f10;
  --line: #e5e7eb;
  --line-strong: #d1d5db;
  --muted: #6b7280;
  --text: #0f172a;
  --accent: #FDE047;
  --accent-soft: #fef08a;
  --accent-deep: #EAB308;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { background: var(--bg); color: var(--text); font-family: var(--font-sans); margin: 0; padding: 0; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 48px 40px; }

header h1 {
  font-size: 32px;
  font-weight: 600;
  margin: 0 0 6px 0;
  letter-spacing: -0.015em;
  line-height: 1.15;
}
.meta-line {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 4px 0;
}
.meta-line .repo {
  background: var(--bg-tint);
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--text);
  font-size: 13px;
}
.meta-line .utc-time {
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.02em;
}
.meta-line .sep { color: var(--line-strong); margin: 0 6px; }
.subhead {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 22px 0;
}
.subhead .sep { color: var(--line-strong); margin: 0 6px; }
.subhead b { color: var(--text); font-weight: 500; }

.filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 8px 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
}
.filter-lbl {
  color: var(--text);
  font-weight: 500;
  margin-right: 6px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 11px;
}
.chip {
  display: inline-block;
  background: var(--bg-tint);
  color: var(--text);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
  user-select: none;
  transition: background 100ms, border 100ms;
}
.chip:hover { background: #ecebe1; }
.chip.active {
  background: var(--accent);
  border-color: var(--accent-deep);
  color: var(--dark);
  font-weight: 500;
}
.eval-desc {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 18px 0;
  min-height: 18px;
  line-height: 1.5;
}
.eval-desc b { color: var(--text); font-weight: 500; }

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 24px;
  position: relative;
}
/* Custom hover tooltip for dots. SVG native <title> takes ~1s to appear in
   Chrome, so we render our own HTML tooltip that appears on mouseenter. */
.chart-tooltip {
  position: absolute;
  top: 0; left: 0;
  pointer-events: none;
  z-index: 10;
  background: #0f0f10;
  color: #f3f4f6;
  border: 1px solid #262629;
  border-radius: 6px;
  padding: 8px 10px;
  font: 11px/1.4 ui-monospace, Menlo, monospace;
  white-space: nowrap;
  opacity: 0;
  transform: translate3d(-9999px, -9999px, 0);
  transition: opacity 90ms ease-out;
  box-shadow: 0 4px 12px rgba(0,0,0,0.18);
}
.chart-tooltip.visible { opacity: 1; }
.chart-tooltip .tt-title { color: #EAB308; font-weight: 600; letter-spacing: 0.2px; }
.chart-tooltip .tt-line  { color: #d1d5db; }
.chart-tooltip .tt-num   { color: #f9fafb; }
.dot-group { cursor: pointer; }
.tools-row {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  padding: 6px 8px 0 8px;
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  opacity: 0.75;
}
.tools-row label {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.tools-row label input {
  cursor: pointer;
  transform: scale(0.85);
}

.export-btn {
  position: absolute;
  top: 14px;
  right: 14px;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--muted);
  padding: 3px 5px;
  border-radius: 3px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 0;
  opacity: 0.65;
}
.export-btn:hover { background: var(--bg-tint); color: var(--text); opacity: 1; }
.export-btn svg { display: block; }

svg#chart-svg { display: block; margin: 0 auto; max-width: 100%; height: auto; }

.caption {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  text-align: center;
  margin: 8px 0 0 0;
  min-height: 16px;
}
.caption b { color: var(--text); font-weight: 500; }

.chart-legend {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.chart-legend .group { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chart-legend .group-lbl {
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 9px;
}
.chart-legend .item { display: inline-flex; align-items: center; gap: 4px; }
.chart-legend .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.chart-legend .provider-logo {
  display: inline-block;
  width: 12px; height: 12px;
  object-fit: contain;
  vertical-align: middle;
}
.chart-legend .router-logo {
  display: inline-block;
  height: 11px;
  width: auto;
  max-width: 72px;
  object-fit: contain;
  vertical-align: middle;
  opacity: 0.85;
}
.chart-legend .router-shape { display: inline-block; width: 9px; height: 9px; background: #6b7280; }
.chart-legend .router-shape.circle { border-radius: 50%; }
.chart-legend .router-shape.diamond { transform: rotate(45deg); width: 7px; height: 7px; }
.chart-legend .router-shape.square { border-radius: 1px; }
.chart-legend .router-shape.triangle {
  background: transparent; width: 0; height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-bottom: 8px solid #6b7280;
}

.notice {
  background: var(--panel);
  border: 1px dashed var(--line-strong);
  padding: 24px 28px;
  border-radius: 8px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.55;
  margin-bottom: 24px;
}

.footer-note {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  margin-top: 32px;
  line-height: 1.55;
}
.footer-note code {
  background: var(--bg-tint);
  padding: 1px 6px;
  border-radius: 3px;
}
`;

// ---------------------------------------------------------------------------
// Inline chart script.
// ---------------------------------------------------------------------------

const SCRIPT = `
(function () {
  'use strict';
  var dataEl = document.getElementById('pareto-data');
  if (!dataEl) return;
  var pdata;
  try { pdata = JSON.parse(dataEl.textContent || '{}'); } catch (e) { return; }
  if (!pdata || !pdata.data || !pdata.data.all || pdata.data.all.length < 1) return;

  var PROVIDER_COLOR = {
    baseten:'#7c3aed', fireworks:'#c026d3',
    moonshotai:'#db2777', moonshot:'#db2777', 'moonshot-intl':'#db2777', 'moonshot-cn':'#db2777',
    nebius:'#06b6d4', together:'#f97316', groq:'#16a34a', cerebras:'#eab308',
    deepseek:'#4f6bed', openai:'#10a37f', anthropic:'#cc785c',
    xai:'#0f0f10', 'x-ai':'#0f0f10',
    google:'#ea4335', 'google-gemini':'#ea4335'
  };
  var PROVIDER_STROKE = {
    baseten:'#4c1d95', fireworks:'#701a75',
    moonshotai:'#831843', moonshot:'#831843', 'moonshot-intl':'#831843', 'moonshot-cn':'#831843',
    nebius:'#0e7490', together:'#9a3412', groq:'#166534', cerebras:'#a16207',
    deepseek:'#2f45c2', openai:'#0a6b53', anthropic:'#8a4f3b',
    xai:'#0f0f10', 'x-ai':'#0f0f10',
    google:'#a72820', 'google-gemini':'#a72820'
  };
  var FALLBACK_FILL   = '#6b7280';
  var FALLBACK_STROKE = '#374151';
  var ROUTER_LABEL = { direct:'direct', openrouter:'OR', vercel:'Vercel', bedrock:'Bedrock' };

  var PLOT      = { xL: 60, xR: 860, yT: 100, yB: 500 };
  var X_MIN_LOG = -3, X_MAX_LOG = 0, Y_CEIL = 100;
  var MAJOR_MULT = [1, 2, 5];
  var MINOR_MULT = [3, 4, 6, 7, 8, 9];

  var yFloor = 0;
  var state  = { filter: 'all', showDist: true };

  var svg          = document.getElementById('chart-svg');
  var staticLayer  = document.getElementById('chart-static');
  var contentLayer = document.getElementById('chart-content');
  var chipRow      = document.getElementById('filter-row');
  var evalDesc     = document.getElementById('eval-desc');
  var caption      = document.getElementById('caption');
  var legend       = document.getElementById('chart-legend');
  var distToggle   = document.getElementById('dist-toggle');
  var exportBtn    = document.getElementById('export-btn');
  var tooltipEl    = document.getElementById('chart-tooltip');

  // Shared tooltip handlers. drawDot wires each group to these; the tipHtml
  // string is stashed on the group as .__tipHtml so we don't re-serialize on
  // every mousemove. Positioning is card-relative (getBoundingClientRect on
  // the tooltip's offsetParent) so it stays pinned even when the page scrolls.
  function positionTooltip(evt) {
    if (!tooltipEl) return;
    var parent = tooltipEl.offsetParent || document.body;
    var pRect = parent.getBoundingClientRect();
    var x = evt.clientX - pRect.left + 14;
    var y = evt.clientY - pRect.top + 14;
    // Clamp to viewport-right so the tooltip doesn't hang off the edge.
    var maxX = parent.clientWidth - tooltipEl.offsetWidth - 8;
    if (x > maxX) x = evt.clientX - pRect.left - tooltipEl.offsetWidth - 14;
    tooltipEl.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  }
  function showTooltip(evt) {
    if (!tooltipEl) return;
    var html = this.__tipHtml;
    if (!html) return;
    tooltipEl.innerHTML = html;
    tooltipEl.classList.add('visible');
    positionTooltip(evt);
  }
  function moveTooltip(evt) { positionTooltip(evt); }
  function hideTooltip() {
    if (!tooltipEl) return;
    tooltipEl.classList.remove('visible');
  }

  function xPos(cost) {
    var l = Math.max(X_MIN_LOG, Math.min(X_MAX_LOG, Math.log(cost) / Math.LN10));
    return PLOT.xL + ((l - X_MIN_LOG) / (X_MAX_LOG - X_MIN_LOG)) * (PLOT.xR - PLOT.xL);
  }
  function yPos(quality) {
    var q = Math.max(yFloor, Math.min(Y_CEIL, quality));
    return PLOT.yT + (1 - (q - yFloor) / (Y_CEIL - yFloor)) * (PLOT.yB - PLOT.yT);
  }
  function computeYFloor(dots) {
    if (!dots.length) return 0;
    var minY = Infinity;
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      minY = Math.min(minY, d.y);
      if (typeof d.y_min === 'number') minY = Math.min(minY, d.y_min);
    }
    // Floor to nearest 5% below (minY - 3) rather than nearest 10% below
    // (minY - 4). Tighter framing when data cluster sits well above 0.
    return Math.max(0, Math.floor((minY - 3) / 5) * 5);
  }
  function computeParetoFrontier(dots) {
    var clean = [];
    for (var i = 0; i < dots.length; i++) if (isFinite(dots[i].x) && isFinite(dots[i].y)) clean.push(dots[i]);
    var frontier = [];
    for (var j = 0; j < clean.length; j++) {
      var d = clean[j], dominated = false;
      for (var k = 0; k < clean.length; k++) {
        if (j === k) continue;
        var o = clean[k];
        if (o.x <= d.x && o.y >= d.y && (o.x < d.x || o.y > d.y)) { dominated = true; break; }
      }
      if (!dominated) frontier.push(d);
    }
    return frontier.slice().sort(function (a, b) { return a.x - b.x; });
  }
  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
    return el;
  }
  function shapeEl(shape, cx, cy, r, opts) {
    var attrs = {
      fill: opts.fill || 'none',
      'fill-opacity': opts.fillOpacity == null ? 1 : opts.fillOpacity,
      stroke: opts.stroke || 'none',
      'stroke-width': opts.strokeWidth == null ? 0 : opts.strokeWidth
    };
    if (shape === 'circle') { attrs.cx=cx; attrs.cy=cy; attrs.r=r; return svgEl('circle', attrs); }
    if (shape === 'square') {
      var s = r * 1.75;
      attrs.x = cx - s/2; attrs.y = cy - s/2; attrs.width = s; attrs.height = s;
      return svgEl('rect', attrs);
    }
    if (shape === 'diamond') {
      var d = r * 1.15;
      attrs.points = cx+','+(cy-d)+' '+(cx+d)+','+cy+' '+cx+','+(cy+d)+' '+(cx-d)+','+cy;
      return svgEl('polygon', attrs);
    }
    if (shape === 'triangle') {
      var t = r * 1.35;
      attrs.points = cx+','+(cy-t)+' '+(cx+t*0.87)+','+(cy+t*0.5)+' '+(cx-t*0.87)+','+(cy+t*0.5);
      return svgEl('polygon', attrs);
    }
    attrs.cx=cx; attrs.cy=cy; attrs.r=r; return svgEl('circle', attrs);
  }
  function shapeForRouter(r) {
    if (r === 'direct') return 'circle';
    if (r === 'openrouter') return 'diamond';
    if (r === 'vercel') return 'square';
    if (r === 'bedrock') return 'triangle';
    return 'circle';
  }
  function providerFill(s) { return PROVIDER_COLOR[s] || FALLBACK_FILL; }
  function providerStroke(s) { return PROVIDER_STROKE[s] || FALLBACK_STROKE; }
  function formatDollar(v) {
    if (v >= 1)    return '$' + v.toFixed(0);
    if (v >= 0.1)  return '$' + v.toFixed(2);
    if (v >= 0.01) return '$' + v.toFixed(2);
    return '$' + v.toFixed(3);
  }
  function escapeText(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderAxes(root) {
    for (var d = X_MIN_LOG; d <= X_MAX_LOG; d++) {
      var x = xPos(Math.pow(10, d));
      root.appendChild(svgEl('line', {
        x1:x, y1:PLOT.yT, x2:x, y2:PLOT.yB,
        stroke:'#e5e7eb', 'stroke-width':1, 'stroke-dasharray':'2,3'
      }));
    }
    for (var dd = X_MIN_LOG; dd < X_MAX_LOG; dd++) {
      for (var m = 0; m < MINOR_MULT.length; m++) {
        var v = MINOR_MULT[m] * Math.pow(10, dd);
        if (v > Math.pow(10, X_MAX_LOG)) continue;
        var xm = xPos(v);
        root.appendChild(svgEl('line', {
          x1:xm, y1:PLOT.yB, x2:xm, y2:PLOT.yB + 3,
          stroke:'#9ca3af', 'stroke-width':1
        }));
      }
    }
    var xLabelG = svgEl('g', {
      'font-family':'ui-monospace, Menlo, monospace',
      'font-size':10, fill:'#6b7280', 'text-anchor':'middle'
    });
    for (var ee = X_MIN_LOG; ee <= X_MAX_LOG; ee++) {
      for (var mj = 0; mj < MAJOR_MULT.length; mj++) {
        var vv = MAJOR_MULT[mj] * Math.pow(10, ee);
        if (vv > Math.pow(10, X_MAX_LOG)) continue;
        var xv = xPos(vv);
        root.appendChild(svgEl('line', {
          x1:xv, y1:PLOT.yB, x2:xv, y2:PLOT.yB + 5,
          stroke:'#6b7280', 'stroke-width':1
        }));
        var t = svgEl('text', { x:xv, y:PLOT.yB + 17 });
        t.textContent = formatDollar(vv);
        xLabelG.appendChild(t);
      }
    }
    root.appendChild(xLabelG);

    var xTitle = svgEl('text', {
      x:(PLOT.xL + PLOT.xR) / 2, y:PLOT.yB + 40,
      'font-family':'ui-monospace, Menlo, monospace',
      'font-size':12, fill:'#6b7280', 'text-anchor':'middle'
    });
    xTitle.textContent = '$ per pass  ·  spend / passed  ·  log scale';
    root.appendChild(xTitle);

    var yLabelG = svgEl('g', {
      'font-family':'ui-monospace, Menlo, monospace',
      'font-size':11, fill:'#6b7280', 'text-anchor':'end'
    });
    // Ticks every 2.5%. Major (10-unit) ticks get a solid grid line +
    // dark label. Half-major (5-unit) and quarter (2.5-unit) get dashed
    // hairlines with progressively dimmer labels so the eye still latches
    // onto the 10-unit rhythm quickly.
    var yStep = 2.5;
    for (var q = yFloor; q <= Y_CEIL + 1e-9; q += yStep) {
      var yq = yPos(q);
      var isMajor = Math.abs(q % 10) < 1e-9;
      var isHalf  = !isMajor && Math.abs(q % 5) < 1e-9;
      root.appendChild(svgEl('line', {
        x1:PLOT.xL, y1:yq, x2:PLOT.xR, y2:yq,
        stroke:'#e5e7eb',
        'stroke-width': isMajor ? 1 : (isHalf ? 0.6 : 0.4),
        'stroke-dasharray': isMajor ? '' : (isHalf ? '2,3' : '1,3')
      }));
      var yt = svgEl('text', { x:PLOT.xL - 8, y:yq + 4 });
      // Trim redundant decimals: 12.5 stays; 15.0 shown as 15.
      yt.textContent = (Number.isInteger(q) ? String(q) : q.toFixed(1)) + '%';
      if (!isMajor) yt.setAttribute('fill', isHalf ? '#9ca3af' : '#c0c6cf');
      yLabelG.appendChild(yt);
    }
    root.appendChild(yLabelG);

    root.appendChild(svgEl('line', {
      x1:PLOT.xL, y1:PLOT.yB, x2:PLOT.xR, y2:PLOT.yB,
      stroke:'#d1d5db', 'stroke-width':1.5
    }));
    root.appendChild(svgEl('line', {
      x1:PLOT.xL, y1:PLOT.yT, x2:PLOT.xL, y2:PLOT.yB,
      stroke:'#d1d5db', 'stroke-width':1.5
    }));

    var yTitle = svgEl('text', {
      x:18, y:(PLOT.yT + PLOT.yB) / 2,
      'font-family':'ui-monospace, Menlo, monospace',
      'font-size':12, fill:'#6b7280', 'text-anchor':'middle',
      transform:'rotate(-90 18 ' + ((PLOT.yT + PLOT.yB) / 2) + ')'
    });
    yTitle.textContent = 'response quality (%)';
    root.appendChild(yTitle);
  }

  function renderAttractiveQuadrant(root, dots) {
    if (!dots.length) return;
    var xs = dots.map(function(d){return d.x;}).sort(function(a,b){return a-b;});
    var ys = dots.map(function(d){return d.y;}).sort(function(a,b){return a-b;});
    var xCeil = xs[Math.floor(xs.length * 0.5)];
    var yFA   = ys[Math.floor(ys.length * 0.6)];
    var rx = xPos(xCeil), ry = yPos(yFA);
    if (rx <= PLOT.xL || ry >= PLOT.yB) return;
    root.appendChild(svgEl('rect', {
      x:PLOT.xL, y:PLOT.yT, width:rx - PLOT.xL, height:ry - PLOT.yT,
      fill:'url(#attractive-grad)', stroke:'none'
    }));
    root.appendChild(svgEl('line', {
      x1:rx, y1:PLOT.yT, x2:rx, y2:ry,
      stroke:'#EAB308', 'stroke-opacity':0.35,
      'stroke-width':1, 'stroke-dasharray':'3,4'
    }));
    root.appendChild(svgEl('line', {
      x1:PLOT.xL, y1:ry, x2:rx, y2:ry,
      stroke:'#EAB308', 'stroke-opacity':0.35,
      'stroke-width':1, 'stroke-dasharray':'3,4'
    }));
    var lbl = svgEl('text', {
      x:PLOT.xL + 8, y:PLOT.yT + 16,
      'font-family':'ui-monospace, Menlo, monospace',
      'font-size':10, fill:'#a16207', 'text-anchor':'start'
    });
    lbl.textContent = 'attractive quadrant';
    root.appendChild(lbl);
  }

  function currentDots() {
    return (pdata.data[state.filter] || []).slice();
  }
  function updateEvalDesc() {
    if (!evalDesc) return;
    if (state.filter === 'all') { evalDesc.innerHTML = ''; return; }
    var chip = chipRow ? chipRow.querySelector('.chip[data-eval="' + state.filter + '"]') : null;
    var desc = chip ? chip.getAttribute('data-desc') : '';
    evalDesc.innerHTML = desc
      ? '<b>' + escapeText(state.filter) + ':</b> ' + escapeText(desc)
      : '<b>' + escapeText(state.filter) + '</b>';
  }

  function render() {
    updateEvalDesc();
    var dots = currentDots();
    yFloor = computeYFloor(dots);

    staticLayer.innerHTML = '';
    renderAxes(staticLayer);
    renderAttractiveQuadrant(staticLayer, dots);

    contentLayer.innerHTML = '';
    var frontier = computeParetoFrontier(dots);
    var frontierSet = {};
    for (var i = 0; i < frontier.length; i++) frontierSet[frontier[i].destSlug] = true;

    if (frontier.length >= 2) {
      var pts = frontier.map(function(d) { return xPos(d.x) + ',' + yPos(d.y); }).join(' ');
      contentLayer.appendChild(svgEl('polyline', {
        points: pts, fill: 'none', stroke: '#EAB308',
        'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
      }));
    }

    // Split a label into up to 2 lines to keep the dot cluster readable.
    // Threshold picked so short IDs like "GPT 5" stay one line but longer
    // ones like "Gemini 3.1 Pro Preview" wrap. Break at the first space
    // AFTER the target position, or fall back to a single line if no space.
    function wrapLabelTo2Lines(text, targetFirstLine) {
      if (text.length <= 16) return [text];
      var splitIx = -1;
      for (var i = targetFirstLine; i < text.length && i < targetFirstLine + 8; i++) {
        if (text.charAt(i) === ' ') { splitIx = i; break; }
      }
      if (splitIx < 0) {
        // Fallback — try earlier space.
        for (var j = targetFirstLine - 1; j > 4; j--) {
          if (text.charAt(j) === ' ') { splitIx = j; break; }
        }
      }
      if (splitIx < 0) return [text];
      return [text.substring(0, splitIx), text.substring(splitIx + 1)];
    }

    function drawDot(d) {
      var isFront = !!frontierSet[d.destSlug];
      var cx = xPos(d.x), cy = yPos(d.y);
      var shape = shapeForRouter(d.router);
      var fill = providerFill(d.providerSlug);
      var strokeDark = providerStroke(d.providerSlug);
      var logoUri = (pdata.providerLogos || {})[d.providerSlug];

      // Group with mouse handlers wired to the shared #chart-tooltip div.
      // SVG native <title> takes ~1s to appear in Chrome, so custom is worth
      // the ~30 lines. Kept minimal — no library, no per-dot listener leak
      // (handlers reference the shared tooltipEl, all groups garbage-collect
      // together on re-render).
      var group = svgEl('g', { class: 'dot-group', 'data-dest': d.destSlug });
      var routerName = d.router === 'direct' ? 'direct' : (ROUTER_LABEL[d.router] || d.router);
      var passesLine = (d.passed != null && d.attempted != null)
        ? '<div class="tt-line"><span class="tt-num">' + d.passed + '/' + d.attempted + '</span> passes</div>'
        : '';
      var tipHtml =
        '<div class="tt-title">' + escapeText(d.model) + '</div>' +
        '<div class="tt-line">' + escapeText(d.provider) + ' · ' + escapeText(routerName) +
        (d.variant ? ' · ' + escapeText(d.variant) : '') + '</div>' +
        '<div class="tt-line"><span class="tt-num">' + formatDollar(d.x) + '</span> per pass · quality <span class="tt-num">' + d.y.toFixed(1) + '%</span></div>' +
        passesLine;
      group.__tipHtml = tipHtml;
      group.addEventListener('mouseenter', showTooltip);
      group.addEventListener('mousemove',  moveTooltip);
      group.addEventListener('mouseleave', hideTooltip);

      // Frontier canary ring
      if (isFront) {
        group.appendChild(shapeEl(shape, cx, cy, 13, {
          fill: 'none', stroke: '#EAB308', strokeWidth: 2
        }));
      }
      // Router shape: white background with provider-coloured border. Logo
      // rides on top; the shape's silhouette still encodes Router.
      group.appendChild(shapeEl(shape, cx, cy, isFront ? 11 : 10, {
        fill: '#ffffff', fillOpacity: isFront ? 1 : 0.92,
        stroke: strokeDark, strokeWidth: isFront ? 1.75 : 1.25
      }));
      // Logo inside if available; otherwise a smaller solid-color inner shape
      // so provider fill is still visible.
      if (logoUri) {
        var imgSize = isFront ? 15 : 13;
        var img = svgEl('image', {
          x: cx - imgSize / 2, y: cy - imgSize / 2,
          width: imgSize, height: imgSize,
          href: logoUri,
          preserveAspectRatio: 'xMidYMid meet',
          opacity: isFront ? 1 : 0.75
        });
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', logoUri);
        group.appendChild(img);
      } else {
        // No logo — fall back to provider-coloured inner dot
        group.appendChild(shapeEl('circle', cx, cy, isFront ? 4.5 : 4, {
          fill: fill, fillOpacity: isFront ? 1 : 0.7,
          stroke: 'none'
        }));
      }

      var routerBadge = d.router === 'direct' ? '' : ' [' + (ROUTER_LABEL[d.router] || d.router) + ']';
      var variantSuffix = d.variant ? ' · ' + d.variant : '';
      var labelText = d.model + variantSuffix + routerBadge;
      var lines = wrapLabelTo2Lines(labelText, 12);
      // Rough width estimate for the label at 9.5px monospace — each glyph
      // averages ~5.7px. If the label would overrun the plot's right edge,
      // flip it to sit on the LEFT of the dot with text-anchor='end'.
      var longestLine = lines.reduce(function(a, b){ return b.length > a.length ? b : a; }, '');
      var estWidth = longestLine.length * 5.7;
      var flipLeft = (cx + 16 + estWidth) > PLOT.xR;
      var labelX = flipLeft ? (cx - 16) : (cx + 16);
      var label = svgEl('text', {
        x: labelX, y: cy + 3.5,
        'text-anchor': flipLeft ? 'end' : 'start',
        'font-family': 'ui-monospace, Menlo, monospace',
        'font-size': 9.5, fill: isFront ? '#0f172a' : '#6b7280'
      });
      if (lines.length === 1) {
        label.textContent = lines[0];
      } else {
        // Two-line layout: shift the anchor up half a line so the pair sits
        // vertically centered on the dot.
        label.setAttribute('y', String(cy - 1.5));
        var t1 = svgEl('tspan', { x: labelX, dy: 0 });
        t1.textContent = lines[0];
        var t2 = svgEl('tspan', { x: labelX, dy: 10 });
        t2.textContent = lines[1];
        label.appendChild(t1);
        label.appendChild(t2);
      }
      group.appendChild(label);
      contentLayer.appendChild(group);
    }
    var offFront = [], onFront = [];
    for (var d2 = 0; d2 < dots.length; d2++) (frontierSet[dots[d2].destSlug] ? onFront : offFront).push(dots[d2]);
    for (var of_ = 0; of_ < offFront.length; of_++) drawDot(offFront[of_]);
    for (var on_ = 0; on_ < onFront.length; on_++) drawDot(onFront[on_]);

    // Error bars drawn AFTER dots so short bars (span < dot radius) aren't
    // hidden by the dot's fill/logo. Visibility params tuned to be legible
    // over both the cream background and the bright white dot fill: stroke
    // width 1.5px, cap length ±6px, opacity 0.75/0.6, provider color.
    // Users can toggle the whole layer off via the "show per-repeat
    // distribution" checkbox.
    if (state.showDist) {
      var CAP = 6;
      for (var w = 0; w < dots.length; w++) {
        var dw = dots[w];
        var isFront = !!frontierSet[dw.destSlug];
        var col = providerFill(dw.providerSlug);
        var op = isFront ? 0.75 : 0.6;
        var g = svgEl('g', {
          stroke: col, 'stroke-opacity': op, 'stroke-width': 1.5,
          'stroke-linecap': 'round',
        });
        var yw = yPos(dw.y), xw = xPos(dw.x);
        var xa = xPos(dw.x_min), xb = xPos(dw.x_max);
        g.appendChild(svgEl('line', { x1:xa, y1:yw, x2:xb, y2:yw }));
        g.appendChild(svgEl('line', { x1:xa, y1:yw - CAP, x2:xa, y2:yw + CAP }));
        g.appendChild(svgEl('line', { x1:xb, y1:yw - CAP, x2:xb, y2:yw + CAP }));
        var ya = yPos(dw.y_min), yb = yPos(dw.y_max);
        g.appendChild(svgEl('line', { x1:xw, y1:ya, x2:xw, y2:yb }));
        g.appendChild(svgEl('line', { x1:xw - CAP, y1:ya, x2:xw + CAP, y2:ya }));
        g.appendChild(svgEl('line', { x1:xw - CAP, y1:yb, x2:xw + CAP, y2:yb }));
        contentLayer.appendChild(g);
      }
    }

    if (caption) {
      var totalDests = (pdata.data.all || []).length;
      var shown = dots.length;
      var excluded = totalDests - shown;
      var laneWord     = shown === 1 ? 'lane' : 'lanes';
      var frontierWord = frontier.length === 1 ? 'point on the frontier' : 'on the frontier';
      if (state.filter === 'all') {
        caption.innerHTML = 'showing <b>' + shown + '</b> ' + laneWord + ' across all evals · <b>' + frontier.length + '</b> ' + frontierWord;
      } else {
        var msg = 'showing <b>' + shown + '</b> ' + laneWord + ' on <b>' + escapeText(state.filter) + '</b> · <b>' + frontier.length + '</b> ' + frontierWord;
        if (excluded > 0) msg += ' · <b>' + excluded + '</b> excluded (zero passes on this eval)';
        caption.innerHTML = msg;
      }
    }
  }

  function renderLegend() {
    if (!legend) return;
    // Dedupe providers by DISPLAY NAME (so moonshotai + moonshot-intl both
    // map to a single "Moonshot" entry). Use the first slug seen for the logo.
    var providersByName = {};
    var providerOrder = [];
    var routers = {};
    var allDots = pdata.data.all || [];
    for (var i = 0; i < allDots.length; i++) {
      var d = allDots[i];
      if (!providersByName[d.provider]) {
        providersByName[d.provider] = d.providerSlug;
        providerOrder.push(d.provider);
      }
      routers[d.router] = true;
    }
    var html = '';
    html += '<span class="group"><span class="group-lbl">provider</span>';
    var logos = pdata.providerLogos || {};
    for (var p = 0; p < providerOrder.length; p++) {
      var name = providerOrder[p];
      var slug = providersByName[name];
      var swatch = logos[slug]
        ? '<img class="provider-logo" src="' + logos[slug] + '" alt="">'
        : '<span class="swatch" style="background:' + providerFill(slug) + '"></span>';
      html += '<span class="item">' + swatch + escapeText(name) + '</span>';
    }
    html += '</span>';
    html += '<span class="group"><span class="group-lbl">router</span>';
    var routerLogos = pdata.routerLogos || {};
    var routerOrder = ['direct', 'openrouter', 'vercel', 'bedrock'];
    for (var r = 0; r < routerOrder.length; r++) if (routers[routerOrder[r]]) {
      var rk = routerOrder[r];
      var shapeCls = rk === 'direct' ? 'circle'
                   : rk === 'openrouter' ? 'diamond'
                   : rk === 'vercel' ? 'square' : 'triangle';
      var lbl = rk === 'direct' ? 'direct'
              : rk === 'openrouter' ? 'OpenRouter'
              : rk === 'vercel' ? 'Vercel' : 'Bedrock';
      var logo = routerLogos[rk]
        ? '<img class="router-logo" src="' + routerLogos[rk] + '" alt="">'
        : '';
      html += '<span class="item"><span class="router-shape ' + shapeCls + '"></span>' + logo + lbl + '</span>';
    }
    html += '</span>';
    html += '<span class="group"><span class="item"><span class="swatch" style="background:transparent;border:2px solid #EAB308"></span>on Pareto frontier</span></span>';
    legend.innerHTML = html;
  }

  if (chipRow) {
    chipRow.addEventListener('click', function (e) {
      var target = e.target;
      while (target && target !== chipRow && !(target.classList && target.classList.contains('chip'))) {
        target = target.parentNode;
      }
      if (!target || target === chipRow) return;
      var wasActive = target.classList.contains('active');
      var chips = chipRow.querySelectorAll('.chip');
      for (var c = 0; c < chips.length; c++) chips[c].classList.remove('active');
      if (wasActive) { state.filter = 'all'; } else { target.classList.add('active'); state.filter = target.getAttribute('data-eval'); }
      render();
    });
  }
  if (distToggle) {
    distToggle.addEventListener('change', function (e) {
      state.showDist = !!e.target.checked;
      render();
    });
  }
  if (exportBtn) exportBtn.addEventListener('click', exportPNG);

  function exportPNG() {
    try {
      var vb = svg.getAttribute('viewBox').split(/\\s+/).map(Number);
      var vbW = vb[2], vbH = vb[3], scale = 2;
      var canvas = document.createElement('canvas');
      canvas.width  = vbW * scale;
      canvas.height = vbH * scale;
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#fafaf7';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      var svgClone = svg.cloneNode(true);
      svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svgClone.setAttribute('width',  vbW);
      svgClone.setAttribute('height', vbH);
      var xml = new XMLSerializer().serializeToString(svgClone);
      var blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (pngBlob) {
          if (!pngBlob) return;
          var a = document.createElement('a');
          a.href = URL.createObjectURL(pngBlob);
          var repo = (pdata.meta && pdata.meta.repoName) || 'canaryone';
          var sha  = (pdata.meta && pdata.meta.shortSha) ? '-' + pdata.meta.shortSha : '';
          var filt = state.filter === 'all' ? 'all' : state.filter;
          a.download = repo + sha + '-pareto-' + filt + '.png';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
        }, 'image/png');
      };
      img.onerror = function () { URL.revokeObjectURL(url); };
      img.src = url;
    } catch (e) { console.error('[pareto] export failed:', e); }
  }

  renderLegend();
  render();
})();
`;

export type { ParetoData };
