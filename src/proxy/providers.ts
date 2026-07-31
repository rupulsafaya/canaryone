// Router + direct-provider registry for SPEC 3 (multi-router).
//
// Provenance: values verified against live docs in session c1-multirt-29July
// (2026-07-29). Two SPEC 3 §4 corrections applied here — the SPEC itself was
// not edited; see the prose in that session for the full delta.
//   - Vercel AI Gateway host is `ai-gateway.vercel.sh` (not gateway.ai.vercel.app),
//     env var is AI_GATEWAY_API_KEY (Vercel's own convention), validation hits
//     /v1/credits (since /v1/models is unauth and can't reject a bad token).
//   - Cloudflare row was reduced to Workers AI's OpenAI-compat endpoint (single
//     bearer token + account_id, no gateway_id, no double-header BYOK). The
//     full CF AI Gateway BYOK model can come back in v0.2 if we want caching /
//     analytics on top of an upstream provider.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME_C1_DIR = path.join(os.homedir(), '.c1');
const HOME_ENV_PATH = path.join(HOME_C1_DIR, '.env');

export type RouterSlug = 'openrouter' | 'vercel' | 'cloudflare' | 'bedrock';

interface BaseEntry {
  displayName: string;
  status: 'shipped' | 'coming-soon';
  /** Primary token env var — the one prompted for in the ApiKeys screen. */
  primaryEnv: string;
  /** Additional required env vars (e.g. CLOUDFLARE_ACCOUNT_ID). */
  extraEnvs: string[];
  /**
   * URL that returns 200 with the primary token and 401/403 without.
   * May contain `{ENV_VAR}` placeholders resolved against process.env / dotenv.
   */
  validationUrlTemplate: string;
  /** URL for listing models. May equal validationUrlTemplate. */
  catalogUrlTemplate: string;
  /** If true, the catalog fetch needs the primary token in Authorization. */
  catalogNeedsAuth: boolean;
  /**
   * Optional auth-header override for `validationUrlTemplate` and
   * `catalogUrlTemplate`. Default (undefined) uses `Authorization: Bearer <key>`.
   *   - `'anthropic'`: sends `x-api-key: <key>` + `anthropic-version: 2023-06-01`.
   *     Anthropic's `/v1/models` rejects Bearer; chat still uses Bearer on the
   *     OpenAI-compat endpoint.
   * Only affects catalog + validation. `forwardUrl` (chat) always uses Bearer.
   */
  catalogAuthKind?: 'anthropic';
}

/** Anthropic API version pinned for `/v1/models` catalog probes. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

export interface RouterEntry extends BaseEntry {
  kind: 'router';
  slug: RouterSlug;
  /** Chat completions URL. May contain `{ENV_VAR}` placeholders. */
  forwardUrlTemplate: string;
}

export interface DirectEntry extends BaseEntry {
  kind: 'direct';
  /** e.g. 'direct:moonshot-intl'. Always starts with `direct:`. */
  slug: string;
  forwardUrl: string;
}

export type ProviderEntry = RouterEntry | DirectEntry;

// ---------- Router registry ----------

export const ROUTERS: RouterEntry[] = [
  {
    kind: 'router',
    slug: 'openrouter',
    displayName: 'OpenRouter',
    status: 'shipped',
    primaryEnv: 'OPENROUTER_API_KEY',
    extraEnvs: [],
    forwardUrlTemplate: 'https://openrouter.ai/api/v1/chat/completions',
    validationUrlTemplate: 'https://openrouter.ai/api/v1/credits',
    catalogUrlTemplate: 'https://openrouter.ai/api/v1/models',
    catalogNeedsAuth: false,
  },
  {
    kind: 'router',
    slug: 'vercel',
    displayName: 'Vercel AI Gateway',
    status: 'shipped',
    primaryEnv: 'AI_GATEWAY_API_KEY',
    extraEnvs: [],
    forwardUrlTemplate: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    validationUrlTemplate: 'https://ai-gateway.vercel.sh/v1/credits',
    catalogUrlTemplate: 'https://ai-gateway.vercel.sh/v1/models',
    catalogNeedsAuth: false,
  },
  // Cloudflare Workers AI removed 2026-07-29 — most Workers AI models
  // require a Workers Paid plan ($5/mo) and 403 on Free, so the row was
  // more misleading than useful. Bring it back if we settle on a paid-only
  // demo target; the code paths in lane.ts / providers.ts still support
  // the (single-token + account_id) shape.
  //
  // AWS Bedrock — ships as the OpenAI-compat endpoint (only gpt-oss models
  // are served here; other foundation models like Claude/Llama use Bedrock's
  // native Converse API which needs a translator not yet wired). Routes are
  // filtered to gpt-oss in data/route-index.ts so PickRoutes only shows
  // what will actually run. See AWS docs:
  // https://docs.aws.amazon.com/bedrock/latest/userguide/inference-openai.html
  {
    kind: 'router',
    slug: 'bedrock',
    displayName: 'AWS Bedrock',
    status: 'shipped',
    primaryEnv: 'AWS_BEARER_TOKEN_BEDROCK',
    extraEnvs: ['AWS_REGION'],
    // OpenAI-compat chat completions. Region in URL; token in Bearer header.
    forwardUrlTemplate: 'https://bedrock-runtime.{AWS_REGION}.amazonaws.com/openai/v1/chat/completions',
    // Validation + catalog both hit the control plane's ListFoundationModels.
    // Different host (`bedrock.` not `bedrock-runtime.`) but the same Bearer
    // token works for both per AWS's bearer-token doc.
    validationUrlTemplate: 'https://bedrock.{AWS_REGION}.amazonaws.com/foundation-models',
    catalogUrlTemplate: 'https://bedrock.{AWS_REGION}.amazonaws.com/foundation-models',
    catalogNeedsAuth: true,
  },
];

// ---------- Direct provider registry ----------

export const DIRECT_PROVIDERS: DirectEntry[] = [
  {
    kind: 'direct',
    slug: 'direct:moonshot-intl',
    displayName: 'Moonshot AI (intl)',
    status: 'shipped',
    primaryEnv: 'MOONSHOT_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.moonshot.ai/v1/chat/completions',
    validationUrlTemplate: 'https://api.moonshot.ai/v1/models',
    catalogUrlTemplate: 'https://api.moonshot.ai/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:moonshot-cn',
    displayName: 'Moonshot AI (cn)',
    status: 'shipped',
    // Shares the same MOONSHOT_API_KEY as moonshot-intl — the ApiKeys screen
    // renders both under a single "Moonshot (intl + cn)" row, but the lane
    // slugs stay distinct at run time.
    primaryEnv: 'MOONSHOT_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.moonshot.cn/v1/chat/completions',
    validationUrlTemplate: 'https://api.moonshot.cn/v1/models',
    catalogUrlTemplate: 'https://api.moonshot.cn/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:nebius',
    displayName: 'Nebius',
    status: 'shipped',
    primaryEnv: 'NEBIUS_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.studio.nebius.ai/v1/chat/completions',
    validationUrlTemplate: 'https://api.studio.nebius.ai/v1/models',
    catalogUrlTemplate: 'https://api.studio.nebius.ai/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:fireworks',
    displayName: 'Fireworks AI',
    status: 'shipped',
    primaryEnv: 'FIREWORKS_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.fireworks.ai/inference/v1/chat/completions',
    validationUrlTemplate: 'https://api.fireworks.ai/inference/v1/models',
    catalogUrlTemplate: 'https://api.fireworks.ai/inference/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:together',
    displayName: 'Together AI',
    status: 'shipped',
    primaryEnv: 'TOGETHER_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.together.xyz/v1/chat/completions',
    validationUrlTemplate: 'https://api.together.xyz/v1/models',
    catalogUrlTemplate: 'https://api.together.xyz/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:groq',
    displayName: 'Groq',
    status: 'shipped',
    primaryEnv: 'GROQ_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.groq.com/openai/v1/chat/completions',
    validationUrlTemplate: 'https://api.groq.com/openai/v1/models',
    catalogUrlTemplate: 'https://api.groq.com/openai/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:deepseek',
    displayName: 'DeepSeek',
    status: 'shipped',
    primaryEnv: 'DEEPSEEK_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.deepseek.com/chat/completions',
    validationUrlTemplate: 'https://api.deepseek.com/v1/models',
    catalogUrlTemplate: 'https://api.deepseek.com/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:baseten',
    displayName: 'Baseten',
    status: 'shipped',
    primaryEnv: 'BASETEN_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://inference.baseten.co/v1/chat/completions',
    validationUrlTemplate: 'https://inference.baseten.co/v1/models',
    catalogUrlTemplate: 'https://inference.baseten.co/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:cerebras',
    displayName: 'Cerebras',
    status: 'shipped',
    primaryEnv: 'CEREBRAS_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.cerebras.ai/v1/chat/completions',
    validationUrlTemplate: 'https://api.cerebras.ai/v1/models',
    catalogUrlTemplate: 'https://api.cerebras.ai/v1/models',
    catalogNeedsAuth: true,
  },
  // Frontier direct providers (added 2026-07-31 per spec
  // c1-direct-providers-31july-SPEC.md). Compat verified live against real
  // keys — see docs/compat-matrix-31july.md. All 5 pass OpenAI-compat on
  // /chat/completions with `Authorization: Bearer <key>` and identical
  // request shape.
  {
    kind: 'direct',
    slug: 'direct:openai',
    displayName: 'OpenAI',
    status: 'shipped',
    primaryEnv: 'OPENAI_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.openai.com/v1/chat/completions',
    validationUrlTemplate: 'https://api.openai.com/v1/models',
    catalogUrlTemplate: 'https://api.openai.com/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:anthropic',
    displayName: 'Anthropic',
    // Anthropic's OpenAI-compat endpoint at /v1/chat/completions accepts
    // `Authorization: Bearer <key>` — verified 2026-07-31. Native /v1/messages
    // is intentionally not wired (would need a request-body translator; killed
    // per spec kill criteria).
    //
    // Catalog + validation use `catalogAuthKind: 'anthropic'` because
    // /v1/models on api.anthropic.com rejects Bearer — needs x-api-key +
    // anthropic-version. Chat completions (forwardUrl) still use Bearer
    // via the OpenAI-compat endpoint. This is per-provider auth config, not
    // a request-body translator, so it's within spec kill criteria.
    status: 'shipped',
    primaryEnv: 'ANTHROPIC_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.anthropic.com/v1/chat/completions',
    validationUrlTemplate: 'https://api.anthropic.com/v1/models',
    catalogUrlTemplate: 'https://api.anthropic.com/v1/models',
    catalogNeedsAuth: true,
    catalogAuthKind: 'anthropic',
  },
  {
    kind: 'direct',
    slug: 'direct:xai',
    displayName: 'xAI',
    status: 'shipped',
    primaryEnv: 'XAI_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.x.ai/v1/chat/completions',
    validationUrlTemplate: 'https://api.x.ai/v1/models',
    catalogUrlTemplate: 'https://api.x.ai/v1/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:zai',
    displayName: 'Z.ai',
    // OpenAI-compat at /paas/v4/*. Compat verified 2026-07-31 via /models
    // (8 GLM models). Chat probe returned HTTP 429 "insufficient balance"
    // on this account — auth+endpoint work but the Z.ai wallet has no
    // credits, so runs will fail until recharged. This is a runtime
    // account issue, not a code issue; registration is intentionally
    // still `status: 'shipped'` since compat is confirmed.
    status: 'shipped',
    primaryEnv: 'ZAI_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://api.z.ai/api/paas/v4/chat/completions',
    validationUrlTemplate: 'https://api.z.ai/api/paas/v4/models',
    catalogUrlTemplate: 'https://api.z.ai/api/paas/v4/models',
    catalogNeedsAuth: true,
  },
  {
    kind: 'direct',
    slug: 'direct:google-gemini',
    displayName: 'Google Gemini',
    // Google exposes OpenAI-compat at /v1beta/openai/chat/completions on the
    // generativelanguage host. Bearer auth accepted. /v1beta/openai/models
    // returns IDs with a `models/` prefix (e.g. `models/gemini-3.6-flash`);
    // the Haiku canonicalizer strips it and aligns to OR canonical form.
    status: 'shipped',
    primaryEnv: 'GOOGLE_API_KEY',
    extraEnvs: [],
    forwardUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    validationUrlTemplate: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    catalogUrlTemplate: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    catalogNeedsAuth: true,
  },
];

// ---------- Direct-provider pricing (seed) ----------
//
// $/M input, $/M output — kept consistent with OR catalog's per-million shape.
// Missing entries → fallbackModelPrice=null → computeCost returns 0 → report
// renders `—`. Seed with the tweet-demo pairs; extend by hand as new
// (provider, model) pairs enter a run.
//
// Kimi K3 + GLM 5.2 numbers below are placeholders — SPEC §12's sample values.
// Reconcile against live pricing before the exit-criterion run.

export interface DirectPrice { input: number; output: number; }

export const DIRECT_PRICING: Record<string, Record<string, DirectPrice>> = {
  'direct:moonshot-intl': {
    'moonshotai/kimi-k3': { input: 2.50, output: 12.50 },
  },
  'direct:moonshot-cn': {
    'moonshotai/kimi-k3': { input: 2.50, output: 12.50 },
  },
  'direct:nebius': {
    'moonshotai/kimi-k3': { input: 2.80, output: 14.00 },
    'z-ai/glm-5.2': { input: 3.00, output: 15.00 },
  },
  // Fireworks doesn't expose pricing via /models — all fields are metadata
  // (context, tool support, params, MoE flag, etc.). We hand-seed from
  // fireworks.ai/pricing. Verified 2026-07-30 via Vercel's endpoints call
  // which reports the same numbers on the Fireworks endpoint under Kimi K3 Fast.
  'direct:fireworks': {
    'moonshotai/kimi-k3': { input: 3.00, output: 15.00 },        // standard
    'moonshotai/kimi-k3-fast': { input: 4.50, output: 22.50 },   // fast tier
    'z-ai/glm-5.2': { input: 1.40, output: 4.40 },               // per OR catalog Fireworks endpoint
    'z-ai/glm-5.2-fast': { input: 2.10, output: 6.60 },
  },
  'direct:together': {
    'moonshotai/kimi-k3': { input: 3.00, output: 15.00 },        // matches OR Together endpoint
    'z-ai/glm-5.2': { input: 1.40, output: 4.40 },
  },
  // Baseten's slugs on the shared inference endpoint match OR canonical form
  // (moonshotai/Kimi-K3 etc.). Standard-tier pricing per baseten.co/pricing +
  // cross-verified against OR's Baseten fp8 endpoint.
  'direct:baseten': {
    'moonshotai/kimi-k3': { input: 3.00, output: 15.00 },
    'z-ai/glm-5.2': { input: 1.40, output: 4.40 },
  },
  'direct:groq': {},
  'direct:cerebras': {},
  // Frontier direct providers (2026-07-31). Keys are OR canonical slug form
  // (dots, not hyphens, for version numbers) so pricing lookups line up with
  // whatever the Haiku catalog canonicalizer produces. Every value below was
  // hand-verified against the provider's own pricing page AND cross-checked
  // against OpenRouter's /api/v1/models pricing — 100% match on 30+ models.
  // OR resells at exact list price for these five providers, so OR pricing
  // can also serve as a proxy source going forward.
  'direct:deepseek': {
    // deepseek.com/pricing (2026-07-31). Standard rates; off-peak discount
    // not modeled — record standard prices per SPEC §10.5.
    'deepseek/deepseek-v4-flash': { input: 0.14,  output: 0.28 },
    'deepseek/deepseek-v4-pro':   { input: 0.435, output: 0.87 },
  },
  'direct:openai': {
    // developers.openai.com/api/docs/pricing (2026-07-31).
    // -chat-latest, -codex, and -5.1-chat-latest aliases skipped: no explicit
    // pricing entry on the page, and per SPEC kill criteria "unverifiable
    // pricing → skip that model."
    'openai/gpt-5':      { input:  1.25, output:  10.00 },
    'openai/gpt-5-mini': { input:  0.25, output:   2.00 },
    'openai/gpt-5-nano': { input:  0.05, output:   0.40 },
    'openai/gpt-5-pro':  { input: 15.00, output: 120.00 },
    'openai/gpt-5.1':    { input:  1.25, output:  10.00 },
    'openai/gpt-4o':     { input:  2.50, output:  10.00 },
    'openai/gpt-4o-mini':{ input:  0.15, output:   0.60 },
  },
  'direct:anthropic': {
    // platform.claude.com/docs/en/about-claude/pricing (2026-07-31).
    // Sonnet 5 shown at intro pricing ($2/$10), valid through 2026-08-31;
    // reverts to $3/$15 on 2026-09-01. If runs happen after the flip, edit
    // this row before regenerating the report.
    'anthropic/claude-opus-5':     { input:  5.00, output: 25.00 },
    'anthropic/claude-opus-4.8':   { input:  5.00, output: 25.00 },
    'anthropic/claude-opus-4.7':   { input:  5.00, output: 25.00 },
    'anthropic/claude-opus-4.6':   { input:  5.00, output: 25.00 },
    'anthropic/claude-opus-4.5':   { input:  5.00, output: 25.00 },
    'anthropic/claude-opus-4.1':   { input: 15.00, output: 75.00 },  // deprecated
    'anthropic/claude-sonnet-5':   { input:  2.00, output: 10.00 },  // intro thru 2026-08-31
    'anthropic/claude-sonnet-4.6': { input:  3.00, output: 15.00 },
    'anthropic/claude-sonnet-4.5': { input:  3.00, output: 15.00 },
    'anthropic/claude-haiku-4.5':  { input:  1.00, output:  5.00 },
    'anthropic/claude-fable-5':    { input: 10.00, output: 50.00 },
  },
  'direct:xai': {
    // docs.x.ai/docs/models (2026-07-31). Prices are the <200k context tier;
    // xAI applies a 2x multiplier at ≥200k prompt tokens. Chat-eval workloads
    // stay well under that ceiling. If a lane crosses 200k prompt tokens the
    // reported cost will be understated; flag at M8 if it shows up on the chart.
    'x-ai/grok-4.5': { input: 2.00, output: 6.00 },
    'x-ai/grok-4.3': { input: 1.25, output: 2.50 },
    // grok-4.20-{reasoning,non-reasoning,multi-agent} variants exist at the
    // same $1.25/$2.50 price but are omitted from this seed — the canonical
    // slug they resolve to depends on Haiku's alignment against OR's single
    // `x-ai/grok-4.20` entry. Add later if a run wants them.
  },
  'direct:zai': {
    // Z.ai first-party pricing (2026-07-31). Values sourced from OpenRouter's
    // /api/v1/models — OR resells at exact list price for tier-1 direct
    // providers (100% match verified for OpenAI/Anthropic/DeepSeek/xAI/Google
    // on the same day; extending the pattern to Z.ai).
    'z-ai/glm-4.5':      { input: 0.60, output: 2.20 },
    'z-ai/glm-4.5-air':  { input: 0.13, output: 0.85 },
    'z-ai/glm-4.6':      { input: 0.50, output: 2.00 },
    'z-ai/glm-4.7':      { input: 0.40, output: 1.75 },
    'z-ai/glm-5':        { input: 0.95, output: 2.55 },
    'z-ai/glm-5-turbo':  { input: 1.20, output: 4.00 },
    'z-ai/glm-5.1':      { input: 0.966, output: 3.036 },
    'z-ai/glm-5.2':      { input: 1.12, output: 3.52 },
  },
  'direct:google-gemini': {
    // ai.google.dev/gemini-api/docs/pricing (2026-07-31). Paid-tier prices.
    // gemini-*-latest aliases and gemini-2.0-* (deprecated) omitted.
    'google/gemini-3.6-flash':       { input: 1.50, output:  7.50 },
    'google/gemini-3.5-flash':       { input: 1.50, output:  9.00 },
    'google/gemini-3.5-flash-lite':  { input: 0.30, output:  2.50 },
    'google/gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
    'google/gemini-3.1-flash-lite':  { input: 0.25, output:  1.50 },
    'google/gemini-3-flash-preview': { input: 0.50, output:  3.00 },
    'google/gemini-2.5-pro':         { input: 1.25, output: 10.00 },
    'google/gemini-2.5-flash':       { input: 0.30, output:  2.50 },
    'google/gemini-2.5-flash-lite':  { input: 0.10, output:  0.40 },
  },
};

// ---------- Lookups ----------

export function listAllProviders(): ProviderEntry[] {
  return [...ROUTERS, ...DIRECT_PROVIDERS];
}

/**
 * Look up by destination slug. Accepts:
 *   - a router slug alone:      'openrouter', 'vercel', 'cloudflare'
 *   - a router destination:     'openrouter:baseten/fp8', 'vercel:openai/gpt-oss-120b'
 *   - a direct destination:     'direct:moonshot-intl'
 * Returns undefined for unknown slugs.
 */
export function getProvider(destinationSlug: string): ProviderEntry | undefined {
  if (destinationSlug.startsWith('direct:')) {
    const [head, tail] = splitFirstColon(destinationSlug);
    const key = `${head}:${tail}`;
    return DIRECT_PROVIDERS.find((p) => p.slug === key);
  }
  const routerSlug = destinationSlug.includes(':')
    ? destinationSlug.slice(0, destinationSlug.indexOf(':'))
    : destinationSlug;
  return ROUTERS.find((r) => r.slug === routerSlug);
}

/** Router-only lookup by bare router slug. */
export function getRouterMeta(routerSlug: string): RouterEntry | undefined {
  return ROUTERS.find((r) => r.slug === routerSlug);
}

// ---------- Env resolution ----------

export type EnvSource = 'env' | 'dotenv';

export interface EnvValue {
  value: string | null;
  source: EnvSource | null;
}

/**
 * Read `envVar` with precedence process.env > ~/.c1/.env. Returns { value:null,
 * source:null } when neither has it. A2 will replace the dotenv reader with a
 * fuller env-file helper; the interface here stays.
 */
export async function readEnv(envVar: string): Promise<EnvValue> {
  const fromProcess = process.env[envVar];
  if (fromProcess && fromProcess.length) {
    return { value: fromProcess, source: 'env' };
  }
  const fromDotenv = await readDotenvKey(HOME_ENV_PATH, envVar);
  if (fromDotenv) return { value: fromDotenv, source: 'dotenv' };
  return { value: null, source: null };
}

/**
 * Convenience: resolve the primary token for a provider slug ('openrouter',
 * 'vercel', 'cloudflare', 'direct:moonshot-intl', ...). Returns null value +
 * null source when missing.
 */
export async function getApiKey(providerSlug: string): Promise<EnvValue> {
  const entry = getProvider(providerSlug);
  if (!entry) return { value: null, source: null };
  return readEnv(entry.primaryEnv);
}

/**
 * Resolve `{ENV_VAR}` placeholders in a URL template against the current
 * environment. Returns null if any placeholder can't be filled (so callers
 * can surface a clear "partial config" state without a broken URL).
 */
export async function resolveUrlTemplate(template: string): Promise<string | null> {
  const placeholders = [...template.matchAll(/\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]);
  let out = template;
  for (const name of placeholders) {
    const { value } = await readEnv(name);
    if (!value) return null;
    out = out.replaceAll(`{${name}}`, encodeURIComponent(value));
  }
  return out;
}

// ---------- Internal helpers ----------

async function readDotenvKey(envPath: string, key: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    // Same regex shape as scan/orchestrator.ts. A2's env-file.ts will
    // supersede this with a proper parser + writer.
    const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*$`, 'm');
    const m = raw.match(re);
    if (!m) return null;
    const val = m[1].replace(/^["']|["']$/g, '').trim();
    return val.length ? val : null;
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitFirstColon(s: string): [string, string] {
  const ix = s.indexOf(':');
  if (ix < 0) return [s, ''];
  return [s.slice(0, ix), s.slice(ix + 1)];
}

// Exported for tests.
export const HOME_ENV_PATH_FOR_TESTS = HOME_ENV_PATH;
