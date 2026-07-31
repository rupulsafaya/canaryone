// Pure Pareto-frontier computation + dot-building helpers for the report
// scatter chart. See docs/specs/c1-pareto-31july-SPEC.md.

import type { RunData, SessionRow, JudgeVerdict } from './data.js';

export interface PointXY {
  x: number;
  y: number;
}

// A dot `d` is on the frontier iff no other dot dominates it.
// Domination: `a` dominates `b` iff a.x <= b.x AND a.y >= b.y AND
// (a.x < b.x OR a.y > b.y) — lower cost and equal-or-higher quality,
// with at least one strict inequality.
//
// Non-finite (NaN, Infinity) points are filtered up front — they can't
// meaningfully participate in domination and their inclusion would
// silently break the sort.
//
// O(n²) is fine: n <= ~30 in practice, and the caller only runs this
// once per report render.
export function computeParetoFrontier<T extends PointXY>(dots: T[]): T[] {
  const clean = dots.filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y));
  const frontier: T[] = [];
  for (let i = 0; i < clean.length; i++) {
    const d = clean[i];
    let dominated = false;
    for (let j = 0; j < clean.length; j++) {
      if (i === j) continue;
      const o = clean[j];
      const dominates =
        o.x <= d.x && o.y >= d.y && (o.x < d.x || o.y > d.y);
      if (dominates) {
        dominated = true;
        break;
      }
    }
    if (!dominated) frontier.push(d);
  }
  // Stable sort by x ascending.
  return frontier.slice().sort((a, b) => a.x - b.x);
}

// ---------- Destination slug parsing ----------

// destination_slug format (per canaryone-nomenclature memory):
//   direct:<provider>[-<region>]              e.g.  direct:baseten, direct:moonshot-intl
//   openrouter:<provider>[/<variant>]         e.g.  openrouter:baseten/fp8, openrouter:nebius/fp4
//   vercel:<provider>[/<variant>]             e.g.  vercel:nebius, vercel:openai/gpt-oss-120b
//   bedrock:<provider>[/<variant>]
export interface ParsedDest {
  router: string;
  provider: string;
  variant: string | null;
}
export function parseDestSlug(slug: string): ParsedDest {
  const [routerPart, rest = ''] = slug.split(':', 2);
  const slashIx = rest.indexOf('/');
  const provider = slashIx < 0 ? rest : rest.slice(0, slashIx);
  const variant = slashIx < 0 ? null : rest.slice(slashIx + 1);
  return { router: routerPart, provider, variant };
}

// Human display of model_slug values. Vendor prefixes vary per provider:
//   moonshotai/kimi-k3
//   moonshotai/Kimi-K3
//   kimi-k3
//   accounts/fireworks/routers/kimi-k3-fast
// Strip vendor prefix, then title-case dash-separated parts.
export function friendlyModel(modelSlug: string): string {
  let s = modelSlug;
  // Fireworks-specific: accounts/<team>/{routers,models}/<model>
  s = s.replace(/^accounts\/[^/]+\/(?:routers|models)\//, '');
  // Google Gemini catalog IDs are prefixed with `models/`.
  s = s.replace(/^models\//, '');
  // Generic vendor prefix: <vendor>/<model>
  s = s.replace(/^[a-zA-Z0-9._-]+\//, '');
  // Strip trailing dated release pins like `-20251001` (YYYYMMDD) or
  // `-2025-08-07` (YYYY-MM-DD). Provider APIs use these as canonical
  // model IDs; on the chart they add noise without adding meaning.
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  // Collapse version tuples between digits: `-4-5-` → `-4.5-`, `-3-5$` → `-3.5`.
  // Only two consecutive single-digit fragments — leaves `gpt-5`, `grok-4.5`,
  // `deepseek-v4` alone (only one digit) but fixes Anthropic's `claude-opus-4-5`.
  s = s.replace(/-(\d)-(\d)(?=-|$)/g, '-$1.$2');
  const parts = s.split(/[-_]/);
  // Known-brand fixups applied post title-case so "Gpt 5"→"GPT-5",
  // "Glm 5.2"→"GLM-5.2", "Deepseek V4"→"DeepSeek V4". Keep this list short —
  // it's cosmetic-only.
  const BRAND_CASE: Record<string, string> = {
    Gpt: 'GPT', Glm: 'GLM', Deepseek: 'DeepSeek', Xai: 'xAI',
  };
  return parts.map((p) => {
    if (p.length === 0) return p;
    const cased = p[0].toUpperCase() + p.slice(1);
    return BRAND_CASE[cased] ?? cased;
  }).join(' ');
}

// Provider display name. Case-insensitive; canonicalises Moonshot regional
// splits into a single label.
export function friendlyProvider(providerSlug: string): string {
  const s = providerSlug.toLowerCase();
  if (s === 'moonshotai' || s === 'moonshot' || s === 'moonshot-intl') return 'Moonshot';
  if (s === 'moonshot-cn') return 'Moonshot (cn)';
  if (s === 'baseten') return 'Baseten';
  if (s === 'fireworks') return 'Fireworks';
  if (s === 'nebius') return 'Nebius';
  if (s === 'together') return 'Together';
  if (s === 'groq') return 'Groq';
  if (s === 'cerebras') return 'Cerebras';
  if (s === 'deepseek') return 'DeepSeek';
  if (s === 'openai') return 'OpenAI';
  if (s === 'anthropic') return 'Anthropic';
  if (s === 'xai' || s === 'x-ai') return 'xAI';
  if (s === 'google' || s === 'google-gemini') return 'Google';
  return providerSlug;
}

export function friendlyRouter(router: string): string {
  if (router === 'direct') return 'direct';
  if (router === 'openrouter') return 'OpenRouter';
  if (router === 'vercel') return 'Vercel';
  if (router === 'bedrock') return 'Bedrock';
  return router;
}

// ---------- Chart data building ----------

export interface Dot {
  destSlug: string;
  model: string;            // friendlyModel(modelSlug)
  router: string;           // 'direct' | 'openrouter' | 'vercel' | 'bedrock'
  provider: string;         // friendlyProvider(providerSlug) e.g. 'Moonshot'
  providerSlug: string;     // raw provider slug e.g. 'moonshotai' — used for colour lookup
  variant: string | null;
  x: number;                // $/pass  = spend / passed
  y: number;                // avgTraj across visible sessions
  x_min: number;            // per-repeat $/pass, min across repeats that had ≥1 pass
  x_max: number;            // per-repeat $/pass, max
  y_min: number;            // per-repeat avgTraj, min
  y_max: number;            // per-repeat avgTraj, max
  passed: number;
  attempted: number;
  spend: number;
}

export interface EvalDescriptor {
  id: string;               // task_id
  summary: string;
}

export interface ParetoData {
  evals: EvalDescriptor[];
  // Dots keyed by filter: 'all' or a task_id.
  data: Record<string, Dot[]>;
  // Header rollup counts (aggregated across all destinations that appear
  // anywhere — so the header stays stable across filter changes).
  meta: {
    destinationCount: number;
    modelCount: number;
    providerCount: number;
    routerCount: number;
    evalCount: number;
    runsPerEvalPerDest: number;
    repoName: string;
    shortSha: string;
    dateIso: string;
    timeUtc: string;   // "HH:MM:SSZ" — small font next to dateIso
  };
}

// Build one Dot from a set of sessions all belonging to the same destination.
// Returns null when the destination has zero successful passes or no judge
// scores — those get excluded from the chart per SPEC §4.1.
function buildDotFromSessions(
  destSlug: string,
  destSessions: SessionRow[],
  verdictBySession: Map<string, JudgeVerdict>,
): Dot | null {
  if (destSessions.length === 0) return null;
  const modelSlug = destSessions[0].model_slug;
  const parsed = parseDestSlug(destSlug);

  let attempted = 0, passed = 0, spend = 0, trajSum = 0, trajCount = 0;
  for (const s of destSessions) {
    attempted++;
    if (s.status === 'complete') passed++;
    spend += s.cost_usd ?? 0;
    const v = verdictBySession.get(s.id);
    if (v?.trajectory_score != null) { trajSum += v.trajectory_score; trajCount++; }
  }
  // Exclude lanes with no passes, no judge score, or no captured spend. A
  // $0 lane usually means the provider didn't return billing metadata (not
  // that it was actually free) — plotting it at the log-axis floor lies about
  // its cost. Better to drop it than mislead.
  if (passed === 0 || trajCount === 0 || spend <= 0) return null;
  const x = spend / passed;
  const y = trajSum / trajCount;

  // Per-repeat distribution: group by repeat_ix, compute rolled cost/pass and
  // rolled avgTraj for each repeat that has ≥1 pass. Skips no-pass repeats
  // so min/max don't get NaN-poisoned.
  const byRepeat = new Map<number, SessionRow[]>();
  for (const s of destSessions) {
    const arr = byRepeat.get(s.repeat_ix);
    if (arr) arr.push(s); else byRepeat.set(s.repeat_ix, [s]);
  }
  const perRepeatCost: number[] = [];
  const perRepeatTraj: number[] = [];
  for (const rs of byRepeat.values()) {
    let rSpend = 0, rPassed = 0, rTraj = 0, rTrajN = 0;
    for (const s of rs) {
      rSpend += s.cost_usd ?? 0;
      if (s.status === 'complete') rPassed++;
      const v = verdictBySession.get(s.id);
      if (v?.trajectory_score != null) { rTraj += v.trajectory_score; rTrajN++; }
    }
    if (rPassed > 0) perRepeatCost.push(rSpend / rPassed);
    if (rTrajN > 0) perRepeatTraj.push(rTraj / rTrajN);
  }
  const x_min = perRepeatCost.length > 0 ? Math.min(...perRepeatCost) : x;
  const x_max = perRepeatCost.length > 0 ? Math.max(...perRepeatCost) : x;
  const y_min = perRepeatTraj.length > 0 ? Math.min(...perRepeatTraj) : y;
  const y_max = perRepeatTraj.length > 0 ? Math.max(...perRepeatTraj) : y;

  return {
    destSlug,
    model: friendlyModel(modelSlug),
    router: parsed.router,
    provider: friendlyProvider(parsed.provider),
    providerSlug: parsed.provider.toLowerCase(),
    variant: parsed.variant,
    x, y, x_min, x_max, y_min, y_max,
    passed, attempted, spend,
  };
}

// Build the whole { evals, data, meta } blob the section serialises inline.
// Iterates data.sessions once per filter (small — usually <500 rows).
export function buildParetoData(data: RunData): ParetoData {
  const sessions = data.sessions;

  // Group all sessions by LANE = (model_slug, destination_slug), not by
  // destination_slug alone. A single destination like `direct:anthropic`
  // hosts many models (claude-opus-5, claude-sonnet-5, claude-haiku-4.5, …)
  // and each is a distinct dot on the chart. Grouping by destination alone
  // collapsed all Anthropic models into one averaged dot — off-by-a-dimension
  // that only surfaced with the 2026-07-31 direct-provider expansion where
  // multiple models share the same destSlug.
  const laneKey = (s: SessionRow) => `${s.destination_slug}::${s.model_slug}`;
  const allByLane = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const k = laneKey(s);
    const arr = allByLane.get(k);
    if (arr) arr.push(s); else allByLane.set(k, [s]);
  }

  // All-eval aggregate dots
  const allDots: Dot[] = [];
  for (const [, ss] of allByLane) {
    // Any session's destination_slug is fine — they all share it within a lane.
    const dot = buildDotFromSessions(ss[0].destination_slug, ss, data.verdictBySession);
    if (dot) allDots.push(dot);
  }

  // Per-task filtered dots
  const taskIds = [...new Set(sessions.map((s) => s.task_id))].sort();
  const perTask: Record<string, Dot[]> = {};
  for (const taskId of taskIds) {
    const dots: Dot[] = [];
    for (const [, ss] of allByLane) {
      const filtered = ss.filter((s) => s.task_id === taskId);
      if (filtered.length === 0) continue;
      const dot = buildDotFromSessions(filtered[0].destination_slug, filtered, data.verdictBySession);
      if (dot) dots.push(dot);
    }
    perTask[taskId] = dots;
  }

  // Eval descriptors sourced from tasks_meta.summary
  const tasksMetaByTid = new Map<string, string>();
  for (const t of data.tasksMeta) {
    if (t.summary) tasksMetaByTid.set(t.task_id, t.summary);
  }
  const evals: EvalDescriptor[] = taskIds.map((id) => ({
    id,
    summary: tasksMetaByTid.get(id) ?? '',
  }));

  // Meta counts — count only lanes that actually made it onto the chart
  // (data.all), so the header numbers align with what the reader sees.
  // Lanes excluded for zero passes / no judge score / zero spend don't inflate
  // the totals.
  const allDestSlugs = new Set<string>();
  const allModels = new Set<string>();
  const allProviders = new Set<string>();
  const allRouters = new Set<string>();
  for (const dot of allDots) {
    allDestSlugs.add(dot.destSlug);
    allModels.add(dot.model);
    allProviders.add(dot.provider);
    allRouters.add(dot.router);
  }

  // Repeats per (dest, task) — same across all in a well-formed run. Take
  // the mode across destinations to be robust to a single half-completed lane.
  const repeatCounts: number[] = [];
  for (const [, ss] of allByLane) {
    const perTaskRepeats = new Map<string, Set<number>>();
    for (const s of ss) {
      const set = perTaskRepeats.get(s.task_id) ?? perTaskRepeats.set(s.task_id, new Set()).get(s.task_id)!;
      set.add(s.repeat_ix);
    }
    for (const set of perTaskRepeats.values()) repeatCounts.push(set.size);
  }
  const runsPerEvalPerDest = repeatCounts.length > 0 ? mode(repeatCounts) : 0;

  // Repo name / shortSha / timestamp — best-effort from run.target_dir + run.started_at.
  // Not touching git in the report; those are captured in run.meta if available.
  const repoName = pathBasename(data.run.target_dir);
  const shortSha = extractShortSha(data.meta);
  const stampIso = data.run.finished_at ?? data.run.started_at;
  const dateIso = stampIso.slice(0, 10);
  // ISO 8601 time portion (HH:MM:SSZ) — small font under the date.
  const timeUtc = extractIsoTime(stampIso);

  return {
    evals,
    data: { all: allDots, ...perTask },
    meta: {
      destinationCount: allDestSlugs.size,
      modelCount: allModels.size,
      providerCount: allProviders.size,
      routerCount: allRouters.size,
      evalCount: taskIds.length,
      runsPerEvalPerDest,
      repoName,
      shortSha,
      dateIso,
      timeUtc,
    },
  };
}

// "2026-07-31T21:34:56.123Z" → "21:34:56Z"; malformed → "".
function extractIsoTime(iso: string): string {
  const match = iso.match(/T(\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]}Z` : '';
}

// ---------- helpers ----------

function pathBasename(p: string | null | undefined): string {
  if (!p) return 'unknown';
  const trimmed = p.replace(/\/+$/, '');
  const ix = trimmed.lastIndexOf('/');
  return ix < 0 ? trimmed : trimmed.slice(ix + 1);
}

function extractShortSha(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = meta as any;
  const sha = m.gitSha ?? m.git_sha ?? m.commitSha ?? m.commit_sha ?? '';
  return typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : '';
}

function mode(arr: number[]): number {
  const counts = new Map<number, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = arr[0], bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}
