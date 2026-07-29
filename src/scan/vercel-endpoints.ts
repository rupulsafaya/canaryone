// Vercel AI Gateway per-model endpoints fetcher.
//
// Mirrors src/scan/or-catalog.ts's fetchModelEndpoints — hits Vercel's
// public `/v1/models/{creator}/{model}/endpoints` and normalises the
// response into the same VercelEndpoint shape PickRoutes consumes for
// variant expansion.
//
// Endpoint is public (no auth), same as Vercel's `/v1/models`.

const VERCEL_ENDPOINTS = (creator: string, model: string) =>
  `https://ai-gateway.vercel.sh/v1/models/${creator}/${model}/endpoints`;

export interface VercelEndpoint {
  /** Provider slug used in `providerOptions.gateway.only = [slug]`. */
  providerSlug: string;
  /** Display name (usually equal to providerSlug). */
  displayName: string;
  /** Cost per prompt token in $/token (not per million). */
  promptCost: number | null;
  completionCost: number | null;
  /** Convenience $/M for the ApiKeys / route display. */
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  contextLength: number | null;
  /** Uptime % over the last hour if reported. */
  uptimePct1h: number | null;
  /** True when Vercel reported this endpoint as unhealthy at fetch time. */
  status: number;
}

interface RawVercelEndpoint {
  provider_name?: string;
  provider_slug?: string;
  slug?: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
  status?: number;
  uptime_last_1h?: number | null;
}

/**
 * Fetch endpoints for `<creator>/<model>`. Throws on non-2xx / network
 * errors — callers wrap for fail-soft.
 */
export async function fetchVercelEndpoints(wireSlug: string): Promise<VercelEndpoint[]> {
  const [creator, ...rest] = wireSlug.split('/');
  const model = rest.join('/');
  if (!creator || !model) throw new Error(`vercel: expected creator/model slug, got ${wireSlug}`);
  const url = VERCEL_ENDPOINTS(creator, model);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`vercel endpoints HTTP ${res.status} for ${wireSlug}: ${body.slice(0, 200)}`);
  }
  const body = await res.json() as { data?: { endpoints?: RawVercelEndpoint[] } };
  const raw = body?.data?.endpoints ?? [];
  return raw.map((r) => {
    const slug = String(r.provider_slug ?? r.slug ?? r.provider_name ?? '').trim();
    const promptCost = perTokenCost(r.pricing?.prompt);
    const completionCost = perTokenCost(r.pricing?.completion);
    return {
      providerSlug: slug,
      displayName: r.provider_name ?? slug,
      promptCost,
      completionCost,
      inputPricePerM: promptCost != null ? promptCost * 1_000_000 : null,
      outputPricePerM: completionCost != null ? completionCost * 1_000_000 : null,
      contextLength: typeof r.context_length === 'number' ? r.context_length : null,
      uptimePct1h: typeof r.uptime_last_1h === 'number' ? r.uptime_last_1h : null,
      status: typeof r.status === 'number' ? r.status : 0,
    };
  }).filter((e) => e.providerSlug.length > 0);
}

function perTokenCost(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
