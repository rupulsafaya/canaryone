// §7.0 Data inventory scaffold. Four layers:
//   1. SQLite tables + row counts + column list
//   2. Per-column value distributions (dead-field dimming)
//   3. Recursive JSON body inspector for traffic.jsonl (request + response)
//      and runs.meta_json
//   4. Candidate computed metrics — "ready today" vs "possible additions"

import { describeColumn, profileTrafficBodies, type ColumnDistribution, type JsonKeyProfile, type RunData } from '../data.js';
import { escapeHtml } from '../template.js';
import { fmtDollars, fmtDuration } from '../../lib/fmt.js';

const RUNS_COLS = ['id', 'started_at', 'finished_at', 'status', 'target_dir', 'meta_json'];
const SESSIONS_COLS = [
  'id', 'run_id', 'task_id', 'task_file', 'model_slug', 'destination_slug', 'router',
  'repeat_ix', 'status', 'started_at', 'finished_at', 'cost_usd', 'verify_exit_code',
  'verify_stdout_tail', 'verify_stderr_tail', 'failure_class', 'worktree_path', 'proxy_port',
];
const STEPS_COLS = [
  'id', 'session_id', 'step_ix', 'started_at', 'finished_at', 'http_status', 'inbound_shape',
  'path', 'input_tokens', 'output_tokens', 'cost_usd', 'latency_ms', 'translation_notes',
  'traffic_log_offset', 'traffic_log_length', 'failure_class',
];
const CLASSIFIER_TAGS_COLS = [
  'id', 'session_id', 'dimension', 'value', 'confidence',
  'generated_at', 'model', 'classifier_id', 'classifier_version',
];
const TASKS_META_COLS = ['task_id', 'file', 'summary', 'uses_llm'];

export async function renderInventory(data: RunData): Promise<string> {
  const { run, sessions, steps, classifierTags, tasksMeta, trafficStats, jsonlPath } = data;

  // Layer 3 profiles are expensive-ish (reads whole JSONL) — do them once here.
  const [reqProfiles, respProfiles] = await Promise.all([
    profileTrafficBodies(jsonlPath, 'request'),
    profileTrafficBodies(jsonlPath, 'response'),
  ]);

  const layer1 = renderLayer1({ run, sessions, steps, classifierTags, tasksMeta, trafficStats });
  const layer2 = renderLayer2({ run, sessions, steps, classifierTags, tasksMeta });
  const layer3 = renderLayer3({ run, reqProfiles, respProfiles });
  const layer4 = renderLayer4(data);

  return `
<section id="s0">
  <h2><span class="sec-num">00</span>Data inventory <span class="muted" style="font-weight: 400; font-size: 13px">— scaffold, will be removed once real sections are designed</span></h2>
  <details class="explain">
    <summary>What this is</summary>
    <div class="explain-body">
      <p>Every field the runner recorded for this run, so we can decide which to promote into real report sections. Look at Layer 2 first — <strong>dead fields</strong> (single-value columns) are dimmed and marked; <strong>signal fields</strong> (spread &gt; 1 unique) are candidates for the leaderboard, lane table, and drilldown. Layer 3 opens up the JSON bodies where the interesting content actually lives.</p>
      <p class="muted">Rip this section out once phase 1 lands.</p>
    </div>
  </details>

  <details open>
    <summary style="cursor: pointer; font-weight: 600; font-size: 14px; margin-top: 12px; padding: 4px 0;">Layer 1 · SQLite tables + traffic.jsonl</summary>
    ${layer1}
  </details>

  <details>
    <summary style="cursor: pointer; font-weight: 600; font-size: 14px; margin-top: 20px; padding: 4px 0;">Layer 2 · Per-column value distributions</summary>
    ${layer2}
  </details>

  <details>
    <summary style="cursor: pointer; font-weight: 600; font-size: 14px; margin-top: 20px; padding: 4px 0;">Layer 3 · JSON body inspector (traffic.jsonl + meta.json)</summary>
    ${layer3}
  </details>

  <details open>
    <summary style="cursor: pointer; font-weight: 600; font-size: 14px; margin-top: 20px; padding: 4px 0;">Layer 4 · Candidate computed metrics</summary>
    ${layer4}
  </details>
</section>`;
}

// ---------- Layer 1 ----------

function renderLayer1(args: {
  run: RunData['run'];
  sessions: RunData['sessions'];
  steps: RunData['steps'];
  classifierTags: RunData['classifierTags'];
  tasksMeta: RunData['tasksMeta'];
  trafficStats: RunData['trafficStats'];
}): string {
  const rows = [
    { name: 'runs', count: 1, cols: RUNS_COLS },
    { name: 'sessions', count: args.sessions.length, cols: SESSIONS_COLS },
    { name: 'steps', count: args.steps.length, cols: STEPS_COLS },
    { name: 'classifier_tags', count: args.classifierTags.length, cols: CLASSIFIER_TAGS_COLS },
    { name: 'tasks_meta', count: args.tasksMeta.length, cols: TASKS_META_COLS },
  ];

  const catalog = rows.map((r) => `
    <div class="catalog-row">
      <span class="table-name">${escapeHtml(r.name)}</span>
      <span class="row-count">${r.count} row${r.count === 1 ? '' : 's'}</span>
      <span class="columns">${r.cols.map((c) => escapeHtml(c)).join(', ')}</span>
    </div>`).join('');

  const kindPills = Object.entries(args.trafficStats.kindCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `<span class="pill">${escapeHtml(k)}<span class="n"> ${c}</span></span>`)
    .join('');

  return `
    <div class="catalog">
      ${catalog}
      <div class="catalog-row" style="background: #f0f9ff; border-color: #bae6fd;">
        <span class="table-name">traffic.jsonl</span>
        <span class="row-count">${args.trafficStats.totalLines} records</span>
        <span class="columns" style="color: var(--ink);">
          kinds: ${kindPills || '<span class="muted">(none)</span>'}
          &nbsp;·&nbsp; distinct session_ids: ${args.trafficStats.distinctSessions}
        </span>
      </div>
    </div>`;
}

// ---------- Layer 2 ----------

function renderLayer2(args: {
  run: RunData['run'];
  sessions: RunData['sessions'];
  steps: RunData['steps'];
  classifierTags: RunData['classifierTags'];
  tasksMeta: RunData['tasksMeta'];
}): string {
  const tables = [
    { name: 'runs', rows: [args.run] as unknown as Array<Record<string, unknown>>, cols: RUNS_COLS },
    { name: 'sessions', rows: args.sessions as unknown as Array<Record<string, unknown>>, cols: SESSIONS_COLS },
    { name: 'steps', rows: args.steps as unknown as Array<Record<string, unknown>>, cols: STEPS_COLS },
    { name: 'classifier_tags', rows: args.classifierTags as unknown as Array<Record<string, unknown>>, cols: CLASSIFIER_TAGS_COLS },
    { name: 'tasks_meta', rows: args.tasksMeta as unknown as Array<Record<string, unknown>>, cols: TASKS_META_COLS },
  ];

  return tables.map((t) => {
    const distRows = t.cols.map((col) => {
      const dist = describeColumn(t.rows, col);
      const isDead = dist.kind === 'enum' && dist.dead;
      return `
        <tr class="${isDead ? 'dead' : ''}">
          <td class="col-name">${escapeHtml(col)}</td>
          <td class="col-dist">${renderDistribution(dist)}</td>
          <td class="col-sample">${renderSample(dist)}</td>
        </tr>`;
    }).join('');

    return `
      <div class="dist-block">
        <h4>${escapeHtml(t.name)} <span class="muted" style="text-transform: none; letter-spacing: 0;">(${t.rows.length} row${t.rows.length === 1 ? '' : 's'})</span></h4>
        <table class="dist">
          <thead><tr><th style="width: 200px;">Column</th><th>Distribution</th><th style="width: 260px;">Sample</th></tr></thead>
          <tbody>${distRows}</tbody>
        </table>
      </div>`;
  }).join('');
}

function renderDistribution(d: ColumnDistribution): string {
  switch (d.kind) {
    case 'empty':
      return `<span class="dim">— (all null, ${d.nulls} rows)</span>`;
    case 'id':
      return `${d.unique} unique <span class="muted">(${d.count} rows${d.nulls > 0 ? `, ${d.nulls} null` : ''})</span>`;
    case 'numeric':
      return `min <code>${fmtNum(d.min)}</code> · max <code>${fmtNum(d.max)}</code> · avg <code>${fmtNum(d.avg)}</code>${d.nulls > 0 ? ` <span class="muted">(${d.nulls} null)</span>` : ''}`;
    case 'timestamp':
      return `${escapeHtml(d.earliest.slice(11, 19))} → ${escapeHtml(d.latest.slice(11, 19))} <span class="muted">(span ${fmtDuration(d.spanSec)})</span>`;
    case 'text':
      return `${d.count} rows · avg length ${d.avgLen} chars${d.nulls > 0 ? ` <span class="muted">(${d.nulls} null)</span>` : ''}`;
    case 'enum': {
      const pills = d.top.map((t) => `<span class="pill">${escapeHtml(t.value)}<span class="n"> ${t.count}</span></span>`).join('');
      const more = d.unique > d.top.length ? ` <span class="muted">+${d.unique - d.top.length} more</span>` : '';
      return `${pills}${more}`;
    }
  }
}

function renderSample(d: ColumnDistribution): string {
  if (d.kind === 'text') return escapeHtml(d.sample.slice(0, 100)) + (d.sample.length > 100 ? '…' : '');
  return '';
}

function fmtNum(n: number): string {
  if (!isFinite(n)) return String(n);
  if (Math.abs(n) < 0.001 && n !== 0) return n.toExponential(2);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4);
}

// ---------- Layer 3 ----------

function renderLayer3(args: {
  run: RunData['run'];
  reqProfiles: Map<string, JsonKeyProfile>;
  respProfiles: Map<string, JsonKeyProfile>;
}): string {
  const metaBlob = safeParseJson(args.run.meta_json);
  const metaProfiles = metaBlob ? profileSingleObject(metaBlob) : new Map();

  return `
    <div class="dist-block">
      <h4>traffic.jsonl · request bodies</h4>
      ${renderJsonTree(args.reqProfiles)}
    </div>
    <div class="dist-block">
      <h4>traffic.jsonl · response bodies</h4>
      ${renderJsonTree(args.respProfiles)}
    </div>
    <div class="dist-block">
      <h4>runs.meta_json</h4>
      ${metaProfiles.size > 0 ? renderJsonTree(metaProfiles) : '<p class="muted">(no meta_json for this run)</p>'}
    </div>`;
}

function renderJsonTree(profiles: Map<string, JsonKeyProfile>): string {
  if (profiles.size === 0) return '<p class="muted">(no records)</p>';
  const sorted = [...profiles.values()].sort((a, b) => a.path.localeCompare(b.path));
  const rows = sorted.map((p) => {
    const depth = (p.path.match(/\.|\[\]/g) ?? []).length;
    const indent = '&nbsp;'.repeat(Math.max(0, (depth - 1) * 2));
    const typeSpans = [...p.types].map((t) => `<span class="type-${t}">${t}</span>`).join('|');
    const info: string[] = [];
    if (p.present < p.totalRecords) {
      const pct = Math.round((p.present / p.totalRecords) * 100);
      info.push(`<span class="muted">present ${p.present}/${p.totalRecords} (${pct}%)</span>`);
    }
    if (p.numeric) info.push(`min ${fmtNum(p.numeric.min)}, max ${fmtNum(p.numeric.max)}, avg ${fmtNum(p.numeric.avg)}`);
    if (p.stringSampleLen) info.push(`len ${p.stringSampleLen.min}..${p.stringSampleLen.max} (avg ${Math.round(p.stringSampleLen.avg)})`);
    if (p.arrayLens) info.push(`length ${p.arrayLens.min}..${p.arrayLens.max} (avg ${p.arrayLens.avg.toFixed(1)})`);
    if (p.enumTop && p.enumTop.length > 0 && p.enumTop.length <= 8) {
      const pills = p.enumTop.map((e) => `<span class="pill">${escapeHtml(e.value)}<span class="n"> ${e.count}</span></span>`).join('');
      info.push(pills);
    }
    return `
      <div class="json-key">
        <span class="key-path">${indent}<code>${escapeHtml(p.path)}</code> <span class="muted">${typeSpans}</span></span>
        <span class="key-info">${info.join(' · ')}</span>
      </div>`;
  }).join('');
  return `<div class="json-tree">${rows}</div>`;
}

function safeParseJson(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function profileSingleObject(obj: unknown): Map<string, JsonKeyProfile> {
  // Wrap in a one-element array so profileJsonRecords sees "1 record".
  const map = new Map<string, JsonKeyProfile>();
  walkSingle(obj, '', map, 1);
  return map;
}

// Minimal duplicate of data.ts's walker for a single object — avoids export churn.
function walkSingle(v: unknown, currPath: string, out: Map<string, JsonKeyProfile>, total: number): void {
  const p = currPath || '.';
  const prof = out.get(p) ?? ({ path: p, types: new Set(), present: 0, totalRecords: total } as JsonKeyProfile);
  prof.present++;
  const type = v === null ? 'null'
    : Array.isArray(v) ? 'array'
    : typeof v === 'object' ? 'object'
    : typeof v === 'string' ? 'string'
    : typeof v === 'number' ? 'number'
    : typeof v === 'boolean' ? 'boolean'
    : 'null';
  prof.types.add(type as never);
  if (type === 'array') {
    const arr = v as unknown[];
    prof.arrayLens = { min: arr.length, max: arr.length, avg: arr.length };
    for (const item of arr) walkSingle(item, `${p}[]`, out, total);
  } else if (type === 'object') {
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      walkSingle(val, p === '.' ? `.${key}` : `${p}.${key}`, out, total);
    }
  } else if (type === 'string') {
    const s = v as string;
    prof.stringSampleLen = { min: s.length, max: s.length, avg: s.length };
  } else if (type === 'number') {
    const n = v as number;
    prof.numeric = { min: n, max: n, avg: n };
  }
  out.set(p, prof);
}

// ---------- Layer 4 ----------

function renderLayer4(data: RunData): string {
  const { sessions, verdictBySession } = data;
  const passed = sessions.filter((s) => s.status === 'complete').length;
  const totalSpend = sessions.reduce((a, s) => a + (s.cost_usd ?? 0), 0);

  // Per-lane roll-up (mirror src/runner/print-summary.ts)
  const byLane = new Map<string, { attempted: number; passed: number; spend: number; trajSum: number; trajCount: number }>();
  for (const s of sessions) {
    const key = s.destination_slug;
    const roll = byLane.get(key) ?? { attempted: 0, passed: 0, spend: 0, trajSum: 0, trajCount: 0 };
    roll.attempted++;
    if (s.status === 'complete') roll.passed++;
    roll.spend += s.cost_usd ?? 0;
    const v = verdictBySession.get(s.id);
    if (v?.trajectory_score != null) {
      roll.trajSum += v.trajectory_score;
      roll.trajCount++;
    }
    byLane.set(key, roll);
  }
  const lanes = [...byLane.entries()].map(([lane, r]) => ({
    lane,
    attempted: r.attempted,
    passed: r.passed,
    spend: r.spend,
    avgTraj: r.trajCount > 0 ? r.trajSum / r.trajCount : null,
    dollarsPerPass: r.passed > 0 ? r.spend / r.passed : null,
    weighted: (r.passed > 0 && r.trajCount > 0 && r.trajSum > 0)
      ? (r.spend / r.passed) / (r.trajSum / r.trajCount / 100)
      : null,
  }));

  const bestValue = lanes
    .filter((l) => l.weighted != null)
    .sort((a, b) => a.weighted! - b.weighted!)[0];
  const cheapestRaw = lanes
    .filter((l) => l.dollarsPerPass != null)
    .sort((a, b) => a.dollarsPerPass! - b.dollarsPerPass!)[0];

  const trajValues = [...verdictBySession.values()]
    .map((v) => v.trajectory_score)
    .filter((n): n is number => n != null);
  const trajRange = trajValues.length > 0
    ? `${Math.min(...trajValues)}–${Math.max(...trajValues)}`
    : '(no judge tags)';

  const ready = `
    <table>
      <tr><td class="label">Total spend</td><td><strong>${fmtDollars(totalSpend)}</strong></td></tr>
      <tr><td class="label">Pass rate</td><td>${passed}/${sessions.length}</td></tr>
      <tr><td class="label">Traj range</td><td>${escapeHtml(trajRange)}</td></tr>
      <tr><td class="label">Best value</td><td>${bestValue ? `<code>${escapeHtml(bestValue.lane)}</code> ${fmtDollars(bestValue.weighted!)} weighted/pass` : '<span class="muted">(no lane has weighted metric)</span>'}</td></tr>
      <tr><td class="label">Cheapest raw</td><td>${cheapestRaw ? `<code>${escapeHtml(cheapestRaw.lane)}</code> ${fmtDollars(cheapestRaw.dollarsPerPass!)}/pass${cheapestRaw.avgTraj != null ? ` (traj ${Math.round(cheapestRaw.avgTraj)})` : ''}` : '<span class="muted">(no passing lane)</span>'}</td></tr>
    </table>`;

  const possible = `
    <ul>
      <li>Per-repeat variance (cost, latency, traj)</li>
      <li>p50 / p95 latency per lane</li>
      <li>Trajectory sub-score histograms (action / grounding / verification / efficiency)</li>
      <li>Tool-call count per session (drives the traj⚠ interpretation — see SPEC §4.5)</li>
      <li>Refusal rate (final content empty / finish_reason=stop with no output)</li>
      <li>Failure taxonomy (auth / rate-limit / 5xx / timeout / setup)</li>
      <li>Judge disagreement rate per lane (if same run had multiple judge versions)</li>
      <li>Cache utilization (OR usually returns this in response.usage)</li>
      <li>From/To decision matrix (product0 §04 — deferred to phase 1)</li>
    </ul>`;

  return `
    <div class="metrics-grid">
      <div class="metrics-col">
        <h4>Ready today <span class="muted" style="text-transform: none; letter-spacing: 0;">(already computed in <code>src/runner/print-summary.ts</code>)</span></h4>
        ${ready}
      </div>
      <div class="metrics-col possible">
        <h4>Possible additions <span class="muted" style="text-transform: none; letter-spacing: 0;">(rip out or keep)</span></h4>
        ${possible}
      </div>
    </div>`;
}
