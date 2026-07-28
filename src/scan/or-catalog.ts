import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OrCatalogSchema, type OrCatalog, type CatalogModel, type OrEndpoint } from '../data/schema.js';

const HOME_C1_DIR = path.join(os.homedir(), '.c1');
const CATALOG_PATH = path.join(HOME_C1_DIR, 'or-catalog.json');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;   // 24h

const OR_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const OR_RANKINGS_ENDPOINT = 'https://openrouter.ai/api/frontend/v1/rankings/models?view=day&models=all';
const OR_CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits';

export interface LoadOrCatalogOpts {
  orKey: string | null;         // required for credits; can fetch catalog+rankings without
  force?: boolean;              // ignore cache
  ttlMs?: number;
}

export interface LoadOrCatalogResult {
  catalog: OrCatalog;
  source: 'cache' | 'live' | 'partial';
}

export async function loadOrCatalog(opts: LoadOrCatalogOpts): Promise<LoadOrCatalogResult> {
  const { orKey, force = false, ttlMs = DEFAULT_TTL_MS } = opts;

  if (!force) {
    const cached = await readCache();
    if (cached && !isStale(cached, ttlMs)) {
      return { catalog: cached, source: 'cache' };
    }
  }

  // Fetch all three in parallel. Progressive degrade on any failure.
  const [modelsRes, rankingsRes, creditsRes] = await Promise.allSettled([
    fetchModels(),
    fetchRankings(),
    orKey ? fetchCredits(orKey) : Promise.resolve<number | null>(null),
  ]);

  const errors: string[] = [];
  const modelsRaw = modelsRes.status === 'fulfilled' ? modelsRes.value : null;
  if (modelsRes.status === 'rejected') errors.push(`models: ${errMsg(modelsRes.reason)}`);

  const rankings = rankingsRes.status === 'fulfilled' ? rankingsRes.value : new Map<string, RankingEntry>();
  if (rankingsRes.status === 'rejected') errors.push(`rankings: ${errMsg(rankingsRes.reason)}`);

  const credits = creditsRes.status === 'fulfilled' ? creditsRes.value : null;
  if (creditsRes.status === 'rejected') errors.push(`credits: ${errMsg(creditsRes.reason)}`);

  if (!modelsRaw) {
    // Catalog is unusable without /models — no pricing/family/context. Return
    // a synthetic empty catalog so the UI can surface the error.
    return {
      catalog: {
        version: '0.2',
        fetchedAt: new Date().toISOString(),
        credits,
        models: [],
        errors,
      },
      source: 'partial',
    };
  }

  const merged = mergeCatalog(modelsRaw, rankings);

  const catalog: OrCatalog = {
    version: '0.2',
    fetchedAt: new Date().toISOString(),
    credits,
    models: merged,
    errors: errors.length ? errors : undefined,
  };

  await writeCache(catalog);
  return { catalog, source: errors.length ? 'partial' : 'live' };
}

// ---------- Cache I/O ----------

async function readCache(): Promise<OrCatalog | null> {
  try {
    const raw = await fs.readFile(CATALOG_PATH, 'utf8');
    const parsed = OrCatalogSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeCache(catalog: OrCatalog): Promise<void> {
  await fs.mkdir(HOME_C1_DIR, { recursive: true });
  await fs.writeFile(CATALOG_PATH, JSON.stringify(catalog, null, 2), { mode: 0o600 });
}

function isStale(catalog: OrCatalog, ttlMs: number): boolean {
  const fetched = Date.parse(catalog.fetchedAt);
  if (!Number.isFinite(fetched)) return true;
  return Date.now() - fetched > ttlMs;
}

// ---------- Fetchers ----------

interface RawModel {
  id: string;
  name?: string;
  description?: string;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
  top_provider?: { max_completion_tokens?: number };
  architecture?: { modality?: string; tokenizer?: string };
}

async function fetchModels(): Promise<RawModel[]> {
  const res = await fetch(OR_MODELS_ENDPOINT);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: any = await res.json();
  const arr: RawModel[] = Array.isArray(body?.data) ? body.data : [];
  return arr;
}

interface RankingEntry {
  rankPosition: number;
  totalTokens: number;
  changePct: number;
}

async function fetchRankings(): Promise<Map<string, RankingEntry>> {
  const res = await fetch(OR_RANKINGS_ENDPOINT);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: any = await res.json();
  const arr: any[] = Array.isArray(body?.data) ? body.data : [];

  // Rankings returns permaslugs with dated variant suffixes (e.g.
  // `xiaomi/mimo-v2.5-20260422`) while /api/v1/models exposes only canonical
  // ids (`xiaomi/mimo-v2.5`). Aggregate all variants under the canonical base
  // slug — a single logical model can span multiple date-versioned snapshots.
  const agg = new Map<string, { totalTokens: number; changeSum: number; changeN: number }>();
  for (const row of arr) {
    const permaslug: string | undefined = row?.model_permaslug ?? row?.slug ?? row?.model;
    if (!permaslug) continue;
    const base = canonicalizeSlug(permaslug);
    const promptTok = Number(row?.total_prompt_tokens ?? 0);
    const complTok = Number(row?.total_completion_tokens ?? 0);
    const change = Number(row?.change ?? 0);
    const cur = agg.get(base) ?? { totalTokens: 0, changeSum: 0, changeN: 0 };
    cur.totalTokens += promptTok + complTok;
    if (Number.isFinite(change)) { cur.changeSum += change * 100; cur.changeN++; }
    agg.set(base, cur);
  }

  interface Row { base: string; totalTokens: number; changePct: number; }
  const rows: Row[] = [...agg.entries()].map(([base, v]) => ({
    base,
    totalTokens: v.totalTokens,
    changePct: v.changeN > 0 ? v.changeSum / v.changeN : 0,
  }));
  rows.sort((a, b) => b.totalTokens - a.totalTokens);

  const map = new Map<string, RankingEntry>();
  rows.forEach((r, i) => {
    map.set(r.base, {
      rankPosition: i + 1,
      totalTokens: r.totalTokens,
      changePct: r.changePct,
    });
  });
  return map;
}

// Strip trailing `-YYYYMMDD` variant date from a rankings permaslug so it
// matches the canonical id in /api/v1/models. Also strips `:free`,`:beta`
// suffixes that appear on variant permaslugs but not on catalog ids.
function canonicalizeSlug(permaslug: string): string {
  let s = permaslug;
  s = s.replace(/-\d{8}$/, '');           // -20260422
  s = s.replace(/-\d{4}-\d{2}-\d{2}$/, ''); // -2026-04-22
  s = s.replace(/:(free|beta|alpha|preview|nitro)$/, '');
  return s;
}

async function fetchCredits(orKey: string): Promise<number | null> {
  const res = await fetch(OR_CREDITS_ENDPOINT, {
    headers: { authorization: `Bearer ${orKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: any = await res.json();
  const total = Number(body?.data?.total_credits ?? 0);
  const used = Number(body?.data?.total_usage ?? 0);
  if (!Number.isFinite(total - used)) return null;
  return total - used;
}

// ---------- Merge ----------

function mergeCatalog(rawModels: RawModel[], rankings: Map<string, RankingEntry>): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const m of rawModels) {
    if (!m.id) continue;
    // Skip pseudo-slugs prefixed with `~` (aliases like `~anthropic/claude-haiku-latest`)
    // and any router/routing pseudo-model — these can't be benchmarked directly.
    if (m.id.startsWith('~') || m.id.startsWith('openrouter/')) continue;

    const promptPrice = perMillion(m.pricing?.prompt);
    const completionPrice = perMillion(m.pricing?.completion);
    // Negative pricing means "variable/auto" — treat as unknown so filters and
    // cost calculations don't get poisoned by sentinel values.
    const inputPrice = promptPrice < 0 ? 0 : promptPrice;
    const outputPrice = completionPrice < 0 ? 0 : completionPrice;
    const hasKnownPrice = promptPrice >= 0 && completionPrice >= 0;

    const family = m.id.includes('/') ? m.id.split('/')[0] : 'other';
    const rank = rankings.get(m.id);
    out.push({
      slug: m.id,
      family: normalizeFamily(family),
      displayName: m.name?.trim() || m.id,
      inputPrice,
      outputPrice,
      context: Number(m.context_length ?? 0),
      totalTokens: rank?.totalTokens ?? 0,
      changePct: rank?.changePct ?? 0,
      rankPosition: rank?.rankPosition ?? null,
      isFree: hasKnownPrice && inputPrice === 0 && outputPrice === 0,
    });
  }
  // Sort: ranked first (by rankPosition asc), unranked after (by displayName asc)
  out.sort((a, b) => {
    if (a.rankPosition != null && b.rankPosition != null) return a.rankPosition - b.rankPosition;
    if (a.rankPosition != null) return -1;
    if (b.rankPosition != null) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
  // Renumber ranks so the displayed positions are 1..N over models we can serve.
  // Some absolutely-ranked slugs aren't in /api/v1/models (deprecated aliases);
  // preserving global rank would leave visible gaps like "rank 16 = top of list".
  let displayRank = 1;
  for (const m of out) {
    if (m.rankPosition != null) { m.rankPosition = displayRank++; }
  }
  return out;
}

function perMillion(s: string | number | undefined): number {
  if (s == null) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return n * 1_000_000;
}

function normalizeFamily(f: string): string {
  const l = f.toLowerCase();
  // Map OR provider prefixes to the fixture-family palette in colors.ts.
  const known = ['anthropic', 'openai', 'deepseek', 'google', 'meta', 'qwen', 'mistral', 'cohere', 'z-ai'];
  if (known.includes(l)) return l;
  if (l === 'x-ai') return 'xai';
  if (l === 'meta-llama') return 'meta';
  if (l === 'mistralai') return 'mistral';
  if (l === 'qwen' || l.startsWith('qwen')) return 'qwen';
  return 'other';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- Endpoints (per-model providers) ----------

const OR_MODEL_ENDPOINTS = (slug: string) =>
  `https://openrouter.ai/api/v1/models/${slug}/endpoints`;

interface RawEndpoint {
  provider_name?: string;
  tag?: string;
  quantization?: string | null;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  uptime_last_30m?: number | null;
  status?: number;
}

/**
 * Fetch and merge the endpoints for a single model slug. Returns the parsed
 * OrEndpoint[] and also persists the result into the shared or-catalog.json
 * cache under `endpointsBySlug[slug]`.
 */
export async function fetchModelEndpoints(slug: string): Promise<OrEndpoint[]> {
  const res = await fetch(OR_MODEL_ENDPOINTS(slug));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${slug}`);
  const body: any = await res.json();
  const raw: RawEndpoint[] = body?.data?.endpoints ?? body?.endpoints ?? [];

  const modelFamily = slug.includes('/') ? slug.split('/')[0].toLowerCase() : '';

  const parsed: OrEndpoint[] = raw.map((r) => {
    const provider = String(r.provider_name ?? '?').trim();
    const providerTag = String(r.tag ?? '').trim();
    const quantization = r.quantization && r.quantization !== 'unknown' ? r.quantization : null;
    const contextLength = Number(r.context_length ?? 0);
    const inputPrice = perMillion(r.pricing?.prompt);
    const outputPrice = perMillion(r.pricing?.completion);
    const uptimePct30m = typeof r.uptime_last_30m === 'number' ? r.uptime_last_30m : null;
    const isFirstParty = provider.toLowerCase() === modelFamily
      || provider.toLowerCase().replace(/\s+/g, '') === modelFamily.replace(/\s+/g, '');
    const displayName = quantization ? `${provider} (${quantization})` : provider;
    return {
      provider,
      providerTag,
      displayName,
      quantization,
      contextLength,
      inputPrice,
      outputPrice,
      isFirstParty,
      uptimePct30m,
    };
  }).filter((e) => e.provider !== '?' && e.providerTag !== '');

  // Sort so the intuitive default lands at cursor position 0:
  //   1) first-party (model-family match) first
  //   2) higher uptime first (null uptime treated as 0)
  //   3) lower input price first as tiebreak
  parsed.sort((a, b) => {
    if (a.isFirstParty !== b.isFirstParty) return a.isFirstParty ? -1 : 1;
    const upA = a.uptimePct30m ?? 0;
    const upB = b.uptimePct30m ?? 0;
    if (upA !== upB) return upB - upA;
    if (a.inputPrice !== b.inputPrice) return a.inputPrice - b.inputPrice;
    return a.provider.localeCompare(b.provider);
  });

  // Persist into the shared catalog file so future sessions warm-start.
  await persistEndpoints(slug, parsed);

  return parsed;
}

async function persistEndpoints(slug: string, endpoints: OrEndpoint[]): Promise<void> {
  const current = (await readCache()) ?? null;
  if (!current) return;    // no catalog yet — endpoints will be re-fetched next session
  const next: OrCatalog = {
    ...current,
    endpointsBySlug: {
      ...(current.endpointsBySlug ?? {}),
      [slug]: { fetchedAt: new Date().toISOString(), endpoints },
    },
  };
  await writeCache(next);
}

export function readCachedEndpoints(catalog: OrCatalog | null, slug: string, ttlMs = DEFAULT_TTL_MS): OrEndpoint[] | null {
  if (!catalog?.endpointsBySlug) return null;
  const entry = catalog.endpointsBySlug[slug];
  if (!entry) return null;
  const fetched = Date.parse(entry.fetchedAt);
  if (!Number.isFinite(fetched) || Date.now() - fetched > ttlMs) return null;
  return entry.endpoints;
}

export const CATALOG_PATH_FOR_TESTS = CATALOG_PATH;
