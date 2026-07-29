// Route index — the flat, search-first destination list that replaces the
// PickModels → PickDestinations two-step. Each Route is one (provider,
// wire-slug) pair — no canonicalization required.
//
// Route sources:
//   OR:           orCatalog.models[]            (with pricing + rank)
//   Vercel:       providerCatalogs.vercel.models_raw[]  (identity slugs)
//   Cloudflare:   providerCatalogs.cloudflare.models_raw[]
//   Direct:       providerCatalogs['direct:<name>'].models_raw[]
//
// Follow-up work: preserve per-model pricing from provider-catalog fetches
// (Vercel + CF return it in the same payload; we currently discard). For
// now, non-OR routes show '—' pricing.

import type { OrCatalog, OrEndpoint } from './schema.js';
import type { ProviderCatalogs } from '../scan/provider-catalog.js';
import type { VercelEndpoint } from '../scan/vercel-endpoints.js';
import { ROUTERS, DIRECT_PROVIDERS, DIRECT_PRICING } from '../proxy/providers.js';

export interface Route {
  /** Stable primary key. Format: `${providerSlug}::${wireSlug}` (or `...::variant::${variantSlug}` for gateway underlying-provider routes). */
  id: string;
  /** Provider registry slug: 'openrouter' | 'vercel' | 'bedrock' | 'direct:<name>'. */
  providerSlug: string;
  /** Short display badge shown next to the route: 'via OR', 'Vercel', 'Fireworks', etc. */
  providerDisplayName: string;
  /** Slug we put on the wire in body.model. Provider-native. */
  wireSlug: string;
  /**
   * Canonical slug for LaneSpec.modelSlug — used by judge/DB/reporting for
   * cross-lane aggregation. For OR routes: the OR slug (already canonical).
   * For others: `${providerSlug}::${wireSlug}` — provider-scoped so different
   * providers' identically-named models don't collide in reports.
   */
  canonicalSlug: string;
  /** Nice display name — usually the wire slug, or model name if provider exposed one. */
  displayName: string;
  /** $/M input tokens. null if pricing unknown → report renders '—'. */
  inputPrice: number | null;
  /** $/M output tokens. null if pricing unknown. */
  outputPrice: number | null;
  /** Family bucket for coloring. Best-effort derived from slug. */
  family: string;
  /**
   * Gateway underlying-provider filter, when this Route pins a specific
   * upstream provider inside a gateway (OR / Vercel). Absent for direct
   * providers or "let the gateway pick" routes.
   *   OR:      variantSlug = the OR provider tag ('baseten/fp8')
   *            lane.ts sends `provider.order = [variantSlug]`
   *   Vercel:  variantSlug = the Vercel provider slug ('fireworks')
   *            lane.ts sends `providerOptions.gateway.only = [variantSlug]`
   */
  variantSlug?: string;
  /** Human-readable variant label ('Baseten (fp8)', 'Morph', ...). Displayed inline with providerDisplayName. */
  variantLabel?: string;
  /** Per-variant uptime % (from OR endpoints call). Optional. */
  variantUptime?: number | null;
  /** Search-optimized haystack: lowercase concat of every user-visible field. */
  searchText: string;
}

const FAMILY_ALIASES: Record<string, string> = {
  'moonshotai': 'moonshotai',
  'zai': 'z-ai',
  'zai-org': 'z-ai',
  'zhipu': 'z-ai',
  '@cf': '',                                // strip CF path prefix from family match
  'accounts': '',                           // strip Fireworks path prefix
};

/** Extract a family bucket from a wire slug. Best-effort — used only for coloring. */
export function familyFromSlug(slug: string): string {
  // Common patterns:
  //   openai/gpt-5                           → openai
  //   @cf/moonshotai/kimi-k3                 → moonshotai
  //   accounts/fireworks/models/glm-5p2      → glm (fallback)
  //   zai/glm-5.2                            → z-ai
  //   moonshot-v1-32k                        → moonshotai (fallback)
  const parts = slug.split('/');
  for (const part of parts) {
    const norm = FAMILY_ALIASES[part.toLowerCase()];
    if (norm !== undefined) {
      if (norm.length > 0) return norm;
      continue;
    }
    if (part.length && !part.startsWith('@') && part !== 'accounts' && part !== 'models' && part !== 'routers') {
      return part.toLowerCase();
    }
  }
  // Fall back to first token in the last segment (glm-5p2 → glm).
  const last = parts[parts.length - 1] ?? slug;
  return last.split(/[-_.]/)[0].toLowerCase() || 'other';
}

const ROUTER_BADGES: Record<string, string> = {
  openrouter: 'via OR',
  vercel: 'Vercel',
  bedrock: 'Bedrock',
};

/**
 * Router-specific route filter. Bedrock's catalog lists every foundation
 * model, but only gpt-oss models are served on the OpenAI-compat endpoint
 * we ship — others need the Converse translator (not yet wired). Filter so
 * PickRoutes only shows runnable routes.
 */
function isRouteRunnable(providerSlug: string, wireSlug: string): boolean {
  if (providerSlug === 'bedrock') {
    const s = wireSlug.toLowerCase();
    return s.includes('gpt-oss') || s.includes('openai');
  }
  return true;
}

/**
 * Build the unified route list from all loaded catalogs. Called by PickRoutes
 * on mount and any time a catalog changes. O(total-model-count) — 500-1000
 * entries typical, cheap to rebuild.
 */
export function buildRouteList(
  orCatalog: OrCatalog | null,
  providerCatalogs: ProviderCatalogs,
  vercelEndpointsBySlug: Record<string, VercelEndpoint[]> = {},
): Route[] {
  const routes: Route[] = [];

  // OR routes — one "auto-route" per canonical model, plus N variant routes
  // per model that has per-endpoint data loaded (populated on demand by
  // store.loadEndpointsFor).
  if (orCatalog) {
    for (const model of orCatalog.models) {
      routes.push({
        id: `openrouter::${model.slug}`,
        providerSlug: 'openrouter',
        providerDisplayName: ROUTER_BADGES.openrouter,
        wireSlug: model.slug,
        canonicalSlug: model.slug,
        displayName: model.displayName || model.slug,
        inputPrice: model.inputPrice > 0 ? model.inputPrice : null,
        outputPrice: model.outputPrice > 0 ? model.outputPrice : null,
        family: model.family || familyFromSlug(model.slug),
        searchText: [model.slug, model.displayName, model.family, 'openrouter', 'via OR'].join(' ').toLowerCase(),
      });
      // Variant routes for this model, if endpoints are cached.
      const endpoints = orCatalog.endpointsBySlug?.[model.slug]?.endpoints;
      if (endpoints && endpoints.length > 0) {
        for (const ep of endpoints) {
          routes.push(orVariantRoute(model.slug, model.displayName || model.slug, model.family || familyFromSlug(model.slug), ep));
        }
      }
    }
  }

  // Every OTHER provider — one route per raw slug. No canonicalization; the
  // user picks the exact wire slug they want on their chosen provider.
  const providerSlugs = [
    ...ROUTERS.filter((r) => r.status === 'shipped' && r.slug !== 'openrouter').map((r) => r.slug),
    ...DIRECT_PROVIDERS.filter((p) => p.status === 'shipped').map((p) => p.slug),
  ];
  for (const providerSlug of providerSlugs) {
    const cat = providerCatalogs[providerSlug];
    if (!cat) continue;
    const providerDisplayName = displayNameFor(providerSlug);
    for (const wireSlug of cat.models_raw) {
      if (!isRouteRunnable(providerSlug, wireSlug)) continue;
      const family = familyFromSlug(wireSlug);
      const priceKey = tryDirectPriceKey(providerSlug, wireSlug);
      const price = priceKey ? DIRECT_PRICING[providerSlug]?.[priceKey] ?? null : null;
      routes.push({
        id: `${providerSlug}::${wireSlug}`,
        providerSlug,
        providerDisplayName,
        wireSlug,
        canonicalSlug: `${providerSlug}::${wireSlug}`,
        displayName: wireSlug,
        inputPrice: price?.input ?? null,
        outputPrice: price?.output ?? null,
        family,
        searchText: [wireSlug, providerDisplayName, family, providerSlug].join(' ').toLowerCase(),
      });
      // Vercel variant rows (Fireworks, Morph, etc. underneath the gateway).
      if (providerSlug === 'vercel') {
        const endpoints = vercelEndpointsBySlug[wireSlug];
        if (endpoints && endpoints.length > 0) {
          for (const ep of endpoints) {
            routes.push(vercelVariantRoute(wireSlug, family, ep));
          }
        }
      }
    }
  }

  // Alphabetical within provider group, providers ordered: OR → Vercel → CF → direct
  routes.sort((a, b) => {
    const pa = providerOrder(a.providerSlug);
    const pb = providerOrder(b.providerSlug);
    if (pa !== pb) return pa - pb;
    return a.wireSlug.localeCompare(b.wireSlug);
  });
  return routes;
}

function displayNameFor(providerSlug: string): string {
  if (providerSlug in ROUTER_BADGES) return ROUTER_BADGES[providerSlug];
  if (providerSlug.startsWith('direct:')) {
    const entry = DIRECT_PROVIDERS.find((p) => p.slug === providerSlug);
    return entry?.displayName ?? providerSlug.replace(/^direct:/, '');
  }
  return providerSlug;
}

function orVariantRoute(
  modelSlug: string,
  displayName: string,
  family: string,
  endpoint: OrEndpoint,
): Route {
  const label = endpoint.displayName || endpoint.provider;
  return {
    id: `openrouter::${modelSlug}::variant::${endpoint.providerTag}`,
    providerSlug: 'openrouter',
    providerDisplayName: 'via OR',
    wireSlug: modelSlug,
    canonicalSlug: modelSlug,
    displayName: `${displayName}  ↳ ${label}`,
    inputPrice: endpoint.inputPrice > 0 ? endpoint.inputPrice : null,
    outputPrice: endpoint.outputPrice > 0 ? endpoint.outputPrice : null,
    family,
    variantSlug: endpoint.providerTag,
    variantLabel: label,
    variantUptime: endpoint.uptimePct30m,
    searchText: [modelSlug, displayName, family, 'openrouter', 'via OR', endpoint.provider, endpoint.providerTag, label].join(' ').toLowerCase(),
  };
}

function vercelVariantRoute(wireSlug: string, family: string, endpoint: VercelEndpoint): Route {
  const label = endpoint.displayName || endpoint.providerSlug;
  return {
    id: `vercel::${wireSlug}::variant::${endpoint.providerSlug}`,
    providerSlug: 'vercel',
    providerDisplayName: 'Vercel',
    wireSlug,
    canonicalSlug: `vercel::${wireSlug}`,
    displayName: `${wireSlug}  ↳ ${label}`,
    inputPrice: endpoint.inputPricePerM,
    outputPrice: endpoint.outputPricePerM,
    family,
    variantSlug: endpoint.providerSlug,
    variantLabel: label,
    variantUptime: endpoint.uptimePct1h,
    searchText: [wireSlug, family, 'vercel', endpoint.providerSlug, label].join(' ').toLowerCase(),
  };
}

function providerOrder(providerSlug: string): number {
  if (providerSlug === 'openrouter') return 0;
  if (providerSlug === 'vercel') return 1;
  if (providerSlug === 'bedrock') return 2;
  return 10;
}

// Try common family/version guesses to look up DIRECT_PRICING by canonical
// key. DIRECT_PRICING is keyed by OR-style canonical slugs; direct-provider
// wire slugs are provider-native. This is a best-effort match for the
// tweet-demo pairs we hand-seeded.
function tryDirectPriceKey(providerSlug: string, wireSlug: string): string | null {
  if (!(providerSlug in DIRECT_PRICING)) return null;
  const s = wireSlug.toLowerCase();
  if (s.includes('kimi') && s.includes('k3')) return 'moonshotai/kimi-k3';
  if (s.includes('glm') && (s.includes('5.2') || s.includes('5p2'))) return 'z-ai/glm-5.2';
  return null;
}

/**
 * Filter routes by a case-insensitive substring query. Tokens split on
 * whitespace and must all be present in the route's searchText (AND-match).
 * Empty query returns everything.
 */
export function filterRoutes(routes: Route[], query: string): Route[] {
  const q = query.trim().toLowerCase();
  if (!q) return routes;
  const tokens = q.split(/\s+/);
  return routes.filter((r) => tokens.every((t) => r.searchText.includes(t)));
}
