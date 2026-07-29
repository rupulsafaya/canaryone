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
}

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
  'direct:deepseek': {},
  'direct:cerebras': {},
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
