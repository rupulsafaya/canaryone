// Per-provider model catalog fetcher + Haiku-based slug canonicalizer.
//
// Persists to ~/.c1/provider-catalogs.json (24h TTL, refreshable via `[r]`
// in the ApiKeys screen). One entry per configured provider. Slugs from
// providers that already use OR-style `<owner>/<model>` canonical form
// (OpenRouter, Vercel, and Cloudflare's ?format=openrouter view) skip the
// Haiku call entirely — identity map.
//
// Design goals:
//   - Fail-soft: an unreachable provider yields a stubbed entry with an
//     `errors[]` field, not a thrown exception. The ApiKeys screen surfaces
//     the error inline; PickModels still works with the other providers'
//     catalogs.
//   - Cheap: Haiku ~$0.005 per direct-provider catalog. Called once per
//     token paste + once per user-triggered [r]; never per session.
//   - Deterministic: same raw list → same canonical map (temperature=0).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getProvider, resolveUrlTemplate } from '../proxy/providers.js';

const HOME_C1_DIR = path.join(os.homedir(), '.c1');
const CATALOGS_PATH = path.join(HOME_C1_DIR, 'provider-catalogs.json');
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const CANONICAL_MODEL = 'anthropic/claude-haiku-4.5';
const CANONICAL_MAX_TOKENS = 4000;
const OR_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Providers whose native slugs are already OR-style — no Haiku pass needed. */
const IDENTITY_MAP_PROVIDERS = new Set(['openrouter', 'vercel', 'cloudflare']);

export interface ProviderCatalogEntry {
  fetched_at: string;                       // ISO 8601
  models_raw: string[];                     // provider-native slugs
  canonical_map: Record<string, string>;    // raw → canonical
  /**
   * Set only when this entry is a stub after a failed refresh. Callers
   * (ApiKeys screen) render this inline. Successful entries omit the field.
   */
  errors?: string[];
}

export type ProviderCatalogs = Record<string, ProviderCatalogEntry>;

// ---------- I/O ----------

/**
 * Load the cache file. Missing file → empty object. Malformed JSON is
 * treated as missing (silent) so a corrupted cache doesn't wedge startup;
 * the next refresh rewrites it clean.
 */
export async function loadCatalogs(cachePath: string = CATALOGS_PATH): Promise<ProviderCatalogs> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ProviderCatalogs;
    }
    return {};
  } catch {
    return {};
  }
}

export async function writeCatalogs(
  catalogs: ProviderCatalogs,
  cachePath: string = CATALOGS_PATH,
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(catalogs, null, 2), { mode: 0o600 });
}

export function isStale(entry: ProviderCatalogEntry, ttlMs: number = DEFAULT_TTL_MS): boolean {
  const fetched = Date.parse(entry.fetched_at);
  if (!Number.isFinite(fetched)) return true;
  return Date.now() - fetched > ttlMs;
}

// ---------- Fetch ----------

export interface FetchModelsResult {
  rawSlugs: string[];
}

/**
 * GET the provider's catalog URL. Handles URL-template substitution (for
 * Cloudflare's {CLOUDFLARE_ACCOUNT_ID}) and auth-vs-noauth per registry.
 *
 * Throws on network failure, non-2xx status, or unparseable response body.
 * Callers wrap in try/catch to convert into an errored catalog entry.
 */
export async function fetchModels(providerSlug: string, token: string | null): Promise<FetchModelsResult> {
  const entry = getProvider(providerSlug);
  if (!entry) throw new Error(`unknown provider: ${providerSlug}`);
  if (entry.status !== 'shipped') throw new Error(`provider ${providerSlug} is not shipped yet`);

  const url = await resolveUrlTemplate(entry.catalogUrlTemplate);
  if (!url) throw new Error(`missing env var required for catalog URL of ${providerSlug}`);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (entry.catalogNeedsAuth) {
    if (!token) throw new Error(`catalog for ${providerSlug} requires a token`);
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`HTTP ${res.status} for ${providerSlug} catalog: ${body.slice(0, 200)}`);
  }
  const body = await res.json();
  const rawSlugs = extractSlugs(body);
  if (rawSlugs.length === 0) {
    throw new Error(`no model slugs found in ${providerSlug} catalog response`);
  }
  return { rawSlugs };
}

// ---------- Canonicalize (Haiku one-shot) ----------

export interface CanonicalizeOpts {
  /** OpenRouter key used to route the Haiku call. Required for direct-provider slugs. */
  orKey: string | null;
  /**
   * OR catalog canonical slugs. Passed to Haiku as alignment targets so a
   * direct-provider slug like `accounts/fireworks/models/glm-5p2` maps to the
   * same canonical (`z-ai/glm-5.2`) that OR uses, instead of Haiku inventing
   * a new form. Without this list, different providers get different
   * canonical strings for the same model and PickDestinations misses matches.
   */
  orCanonicalSlugs?: string[];
  /** Injectable for tests. Defaults to the real OR endpoint. */
  callHaiku?: (rawSlugs: string[], orKey: string, orCanonicalSlugs: string[]) => Promise<Record<string, string>>;
}

/**
 * Convert a list of raw provider-native slugs into { raw → canonical } map.
 *
 * Fast path: if `providerSlug` is in IDENTITY_MAP_PROVIDERS, returns an
 * identity map without calling Haiku.
 *
 * Slow path: single Haiku call with the whole list. On any error (network,
 * malformed JSON, missing entries) falls back to identity — honest
 * degradation. The catalog entry keeps `errors[]` set so the UI can show
 * the failure.
 */
export async function canonicalizeSlugs(
  providerSlug: string,
  rawSlugs: string[],
  opts: CanonicalizeOpts,
): Promise<{ map: Record<string, string>; error?: string }> {
  if (rawSlugs.length === 0) return { map: {} };
  const routerSlug = providerSlug.startsWith('direct:') ? 'direct' : providerSlug;
  if (IDENTITY_MAP_PROVIDERS.has(routerSlug)) {
    return { map: identityMap(rawSlugs) };
  }
  if (!opts.orKey) {
    return { map: identityMap(rawSlugs), error: 'no OR key available to canonicalize; identity fallback' };
  }
  const runner = opts.callHaiku ?? callHaikuLive;
  const orCanonicalSlugs = opts.orCanonicalSlugs ?? [];
  try {
    const returned = await runner(rawSlugs, opts.orKey, orCanonicalSlugs);
    const merged: Record<string, string> = {};
    for (const raw of rawSlugs) {
      const canonical = returned[raw];
      merged[raw] = typeof canonical === 'string' && canonical.length ? canonical : raw;
    }
    return { map: merged };
  } catch (e) {
    return {
      map: identityMap(rawSlugs),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function identityMap(rawSlugs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of rawSlugs) out[s] = s;
  return out;
}

const CANONICALIZE_SYSTEM = [
  'You normalise LLM model identifiers to canonical OpenRouter-style slugs.',
  'Input: an object with `raw` (provider-native slugs to normalise) and',
  '`or_canonical` (OpenRouter canonical slugs to align to WHEN THEY MATCH THE SAME MODEL).',
  'Output: a JSON object mapping each raw string to a canonical slug.',
  'ALIGNMENT RULE: If a raw slug refers to the SAME model as an entry in',
  '`or_canonical` (same family, same version, same variant), map it to that',
  'OR canonical slug verbatim. This is the highest-priority rule — do not',
  'invent a new canonical form when an OR one already exists.',
  'Examples: raw `zai/glm-5.2` + OR `z-ai/glm-5.2` → map to `z-ai/glm-5.2`.',
  'raw `accounts/fireworks/models/glm-5p2` + OR `z-ai/glm-5.2` → `z-ai/glm-5.2`.',
  'raw `@cf/zai-org/glm-5.2` + OR `z-ai/glm-5.2` → `z-ai/glm-5.2`.',
  'raw `kimi-k3-preview` + OR `moonshotai/kimi-k3` → `moonshotai/kimi-k3`.',
  'FALLBACK: If no OR canonical matches, synthesise `<owner>/<model>-<variant>`',
  "lowercase hyphenated in OpenRouter's convention.",
  'When uncertain, return the raw string verbatim.',
  'Reply with ONLY the JSON object — no markdown, no prose, no explanations.',
  'Every raw input must appear exactly once as a key.',
].join(' ');

async function callHaikuLive(rawSlugs: string[], orKey: string, orCanonicalSlugs: string[]): Promise<Record<string, string>> {
  const messages = [
    { role: 'system', content: CANONICALIZE_SYSTEM },
    { role: 'user', content: JSON.stringify({ raw: rawSlugs, or_canonical: orCanonicalSlugs }) },
  ];
  const res = await fetch(OR_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${orKey}`,
      'X-Title': 'canaryone-catalog-canonicalize',
    },
    body: JSON.stringify({
      model: CANONICAL_MODEL,
      max_tokens: CANONICAL_MAX_TOKENS,
      temperature: 0,
      messages,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`canonicalize HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('canonicalize: empty content');
  return parseCanonicalContent(content);
}

export function parseCanonicalContent(content: string): Record<string, string> {
  let cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!cleaned.startsWith('{')) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) cleaned = m[0];
  }
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && v.length) out[k] = v;
  }
  return out;
}

// ---------- Refresh (fetch + canonicalize + persist) ----------

export interface RefreshOpts extends CanonicalizeOpts {
  cachePath?: string;
  now?: () => Date;
}

export interface RefreshResult {
  entry: ProviderCatalogEntry;
  changed: boolean;                         // true if new entry differs from prior
}

/**
 * Refresh a single provider's catalog: fetch, canonicalize, persist. Errors
 * do NOT throw — they populate `entry.errors[]` so the ApiKeys screen can
 * render inline status and the cache still gets an entry to compare against
 * on next refresh.
 */
export async function refreshCatalog(
  providerSlug: string,
  token: string | null,
  opts: RefreshOpts = { orKey: null },
): Promise<RefreshResult> {
  const cachePath = opts.cachePath ?? CATALOGS_PATH;
  const now = opts.now ?? (() => new Date());
  const catalogs = await loadCatalogs(cachePath);
  const prior = catalogs[providerSlug];
  const errors: string[] = [];

  let rawSlugs: string[] = [];
  try {
    const fetched = await fetchModels(providerSlug, token);
    rawSlugs = fetched.rawSlugs;
  } catch (e) {
    errors.push(`fetch: ${errMsg(e)}`);
  }

  let canonicalMap: Record<string, string> = {};
  if (rawSlugs.length > 0) {
    const c = await canonicalizeSlugs(providerSlug, rawSlugs, opts);
    canonicalMap = c.map;
    if (c.error) errors.push(`canonicalize: ${c.error}`);
  }

  const entry: ProviderCatalogEntry = {
    fetched_at: now().toISOString(),
    models_raw: rawSlugs,
    canonical_map: canonicalMap,
    ...(errors.length ? { errors } : {}),
  };

  // If the fetch itself failed and we had a prior entry, preserve the prior
  // slug list so PickModels doesn't lose the provider entirely — but still
  // record the fresh timestamp + error so the UI can flag staleness.
  if (rawSlugs.length === 0 && prior) {
    entry.models_raw = prior.models_raw;
    entry.canonical_map = prior.canonical_map;
  }

  catalogs[providerSlug] = entry;
  await writeCatalogs(catalogs, cachePath);

  const changed = !prior
    || prior.models_raw.length !== entry.models_raw.length
    || prior.models_raw.some((s, i) => s !== entry.models_raw[i]);
  return { entry, changed };
}

/**
 * Refresh every provider that has a token available. Convenience for the
 * ApiKeys screen's shift-R gesture. Runs in parallel.
 */
export async function refreshAllConfigured(
  tokens: Record<string, string | null>,
  opts: RefreshOpts = { orKey: null },
): Promise<Record<string, RefreshResult>> {
  const providers = Object.keys(tokens);
  const results = await Promise.all(providers.map(async (slug) => {
    const token = tokens[slug];
    const result = await refreshCatalog(slug, token, opts);
    return [slug, result] as const;
  }));
  return Object.fromEntries(results);
}

// ---------- Internal helpers ----------

/**
 * Pull an array of model-ID strings from any of the common response shapes:
 *   OpenAI-compat:   { data: [{ id, ... }] }
 *   Bedrock:         { modelSummaries: [{ modelId, ... }] }
 *   Cloudflare:      { result: [{ id, ... }], success: true }
 *   CF openrouter:   { result: { data: [{ id, ... }] } }
 *   OR /v1/models:   { data: [{ id, ... }] }  (same as OpenAI-compat)
 */
export function extractSlugs(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const candidates: unknown[] = [
    b.data,
    b.models,
    b.modelSummaries,                                        // AWS Bedrock ListFoundationModels
    (b.result as Record<string, unknown> | undefined)?.data,
    b.result,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const slugs = c
        .map((item) => {
          if (item && typeof item === 'object') {
            const rec = item as Record<string, unknown>;
            const id = rec.id ?? rec.modelId ?? rec.name ?? rec.model;
            return typeof id === 'string' ? id : null;
          }
          return typeof item === 'string' ? item : null;
        })
        .filter((s): s is string => s !== null && s.length > 0);
      if (slugs.length > 0) return slugs;
    }
  }
  return [];
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Exports for tests.
export const CATALOGS_PATH_FOR_TESTS = CATALOGS_PATH;
export const CANONICAL_MODEL_FOR_TESTS = CANONICAL_MODEL;
