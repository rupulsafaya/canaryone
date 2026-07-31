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

/**
 * Nomenclature (locked in memory + SPEC 3):
 *   Model    — canonical model identity (Kimi K3, GLM 5.2)
 *   Router   — the gateway/proxy layer (OpenRouter, Vercel, Bedrock, direct)
 *   Provider — the underlying HOST serving the model (Baseten, Fireworks,
 *              Moonshot AI, Nebius…) — distinct from Router!
 *   Variant  — quantization or tier variant of a provider (fp8, mxfp4)
 *   Destination = (Router, Provider[, Variant]) tuple — one lane.
 *
 * The 'providerSlug' field name predates this cleanup and is now legacy —
 * it actually names the ROUTER registry key ('openrouter', 'vercel', ...).
 * A future rename would touch too many call sites; the type comments below
 * spell out the current semantics so nobody drifts again.
 */
export interface Route {
  /** Stable primary key. Format: `${routerSlug}::${wireSlug}` (or `...::variant::${variantSlug}` for gateway underlying-provider routes). */
  id: string;
  /** Router registry slug: 'openrouter' | 'vercel' | 'bedrock' | 'direct:<provider>'. Legacy field name. */
  providerSlug: string;
  /** Human router label — 'OpenRouter', 'Vercel', 'Bedrock', 'direct'. Shown in the Router column. */
  routerLabel: string;
  /**
   * Human PROVIDER (host) label — 'Baseten (fp8)', 'Fireworks', 'Moonshot AI (intl)',
   * '(any)' for a gateway route with no pinned upstream. Shown in the Provider column.
   */
  providerLabel: string;
  /** Slug we put on the wire in body.model. Provider-native. */
  wireSlug: string;
  /**
   * Canonical slug for LaneSpec.modelSlug — used by judge/DB/reporting for
   * cross-lane aggregation. For OR routes: the OR slug (already canonical).
   * For others: `${routerSlug}::${wireSlug}` — router-scoped so different
   * routers' identically-named models don't collide in reports.
   */
  canonicalSlug: string;
  /** Model display name — pure, without router/provider suffixes. */
  displayName: string;
  /** $/M input tokens. null if pricing unknown → report renders '—'. */
  inputPrice: number | null;
  /** $/M output tokens. null if pricing unknown. */
  outputPrice: number | null;
  /** Family bucket for coloring. Best-effort derived from slug. */
  family: string;
  /**
   * Gateway underlying-provider filter, when this Route pins a specific
   * upstream Provider inside a Router. Absent for direct routes or "let
   * the gateway auto-pick" routes.
   *   OpenRouter:  variantSlug = OR provider tag ('baseten/fp8')
   *                lane.ts sends `provider.order = [variantSlug]`
   *   Vercel:      variantSlug = Vercel provider slug ('fireworks')
   *                lane.ts sends `providerOptions.gateway.only = [variantSlug]`
   */
  variantSlug?: string;
  /** Optional per-variant uptime % (OR endpoints call reports this). */
  variantUptime?: number | null;
  /** True when this route pins a specific Provider inside a gateway Router. */
  isVariant: boolean;
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

const ROUTER_LABELS: Record<string, string> = {
  openrouter: 'OpenRouter',
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

  // OR routes — one "auto" catch-all per canonical model, plus N variant
  // routes per model that has per-endpoint data loaded. When variants are
  // present the "auto" row is suppressed: it collapses to "let OR pick one
  // of the routes below" which is redundant next to the concrete choices.
  if (orCatalog) {
    for (const model of orCatalog.models) {
      const endpoints = orCatalog.endpointsBySlug?.[model.slug]?.endpoints ?? [];
      const family = model.family || familyFromSlug(model.slug);
      const displayName = model.displayName || model.slug;
      if (endpoints.length === 0) {
        routes.push({
          id: `openrouter::${model.slug}`,
          providerSlug: 'openrouter',
          routerLabel: ROUTER_LABELS.openrouter,
          providerLabel: '(any)',
          wireSlug: model.slug,
          canonicalSlug: model.slug,
          displayName,
          inputPrice: model.inputPrice > 0 ? model.inputPrice : null,
          outputPrice: model.outputPrice > 0 ? model.outputPrice : null,
          family,
          isVariant: false,
          searchText: [model.slug, displayName, family, 'openrouter'].join(' ').toLowerCase(),
        });
      } else {
        for (const ep of endpoints) {
          routes.push(orVariantRoute(model.slug, displayName, family, ep));
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
  for (const routerSlug of providerSlugs) {
    const cat = providerCatalogs[routerSlug];
    if (!cat) continue;
    const routerLabel = routerLabelFor(routerSlug);
    const isDirect = routerSlug.startsWith('direct:');
    // Direct routers are already at leaf (they ARE the provider). Router label
    // shows 'direct'; Provider label shows the direct provider's display name.
    for (const wireSlug of cat.models_raw) {
      if (!isRouteRunnable(routerSlug, wireSlug)) continue;
      const family = familyFromSlug(wireSlug);
      // Pricing resolution chain, in order:
      //   1. DIRECT_PRICING keyed by Haiku's canonical form (cat.canonical_map[wireSlug])
      //      — hand-seeded, per-provider pricing. Most accurate; used first.
      //   2. tryDirectPriceKey — legacy family regex (Kimi/GLM) for the 9
      //      pre-2026-07-31 providers that didn't have canonical_map coverage.
      //   3. **OR catalog fallback** — added 0.3.1. If canonical maps to an
      //      OpenRouter-catalog entry, use OR's `inputPrice`/`outputPrice`.
      //      Verified 2026-07-31 that OR resells at exact provider list price
      //      for the 6 tier-1 direct providers (100% match on 30+ models).
      //      Extends automatic pricing to any model canonicalizable to an
      //      OR-cataloged slug — no per-model hand-seeding required.
      const canonical = cat.canonical_map?.[wireSlug];
      let priceKey: string | null = null;
      if (canonical && DIRECT_PRICING[routerSlug]?.[canonical]) {
        priceKey = canonical;
      } else {
        priceKey = tryDirectPriceKey(routerSlug, wireSlug);
      }
      let price = priceKey ? DIRECT_PRICING[routerSlug]?.[priceKey] ?? null : null;
      if (!price && canonical && orCatalog) {
        const orMeta = orCatalog.models.find((m) => m.slug === canonical);
        if (orMeta && (orMeta.inputPrice > 0 || orMeta.outputPrice > 0)) {
          price = { input: orMeta.inputPrice, output: orMeta.outputPrice };
        }
      }
      // Vercel: only emit the "auto" row when no per-provider endpoints
      // are loaded yet. Once endpoints load, users pick variants directly.
      const vercelEndpoints = routerSlug === 'vercel' ? (vercelEndpointsBySlug[wireSlug] ?? []) : [];
      const suppressAuto = routerSlug === 'vercel' && vercelEndpoints.length > 0;
      if (!suppressAuto) {
        routes.push({
          id: `${routerSlug}::${wireSlug}`,
          providerSlug: routerSlug,
          routerLabel,
          providerLabel: isDirect
            ? directProviderLabel(routerSlug)
            : '(any)',
          wireSlug,
          canonicalSlug: `${routerSlug}::${wireSlug}`,
          displayName: wireSlug,
          inputPrice: price?.input ?? null,
          outputPrice: price?.output ?? null,
          family,
          isVariant: false,
          searchText: [wireSlug, routerLabel, family, routerSlug].join(' ').toLowerCase(),
        });
      }
      if (routerSlug === 'vercel' && vercelEndpoints.length > 0) {
        for (const ep of vercelEndpoints) {
          routes.push(vercelVariantRoute(wireSlug, family, ep));
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

function routerLabelFor(routerSlug: string): string {
  if (routerSlug in ROUTER_LABELS) return ROUTER_LABELS[routerSlug];
  if (routerSlug.startsWith('direct:')) return 'direct';
  return routerSlug;
}

function directProviderLabel(routerSlug: string): string {
  const entry = DIRECT_PROVIDERS.find((p) => p.slug === routerSlug);
  return entry?.displayName ?? routerSlug.replace(/^direct:/, '');
}

function orVariantRoute(
  modelSlug: string,
  displayName: string,
  family: string,
  endpoint: OrEndpoint,
): Route {
  const providerLabel = endpoint.displayName || endpoint.provider;
  return {
    id: `openrouter::${modelSlug}::variant::${endpoint.providerTag}`,
    providerSlug: 'openrouter',
    routerLabel: ROUTER_LABELS.openrouter,
    providerLabel,
    wireSlug: modelSlug,
    canonicalSlug: modelSlug,
    displayName,
    inputPrice: endpoint.inputPrice > 0 ? endpoint.inputPrice : null,
    outputPrice: endpoint.outputPrice > 0 ? endpoint.outputPrice : null,
    family,
    variantSlug: endpoint.providerTag,
    variantUptime: endpoint.uptimePct30m,
    isVariant: true,
    searchText: [modelSlug, displayName, family, 'openrouter', endpoint.provider, endpoint.providerTag, providerLabel].join(' ').toLowerCase(),
  };
}

function vercelVariantRoute(wireSlug: string, family: string, endpoint: VercelEndpoint): Route {
  const providerLabel = endpoint.displayName || endpoint.providerSlug;
  return {
    id: `vercel::${wireSlug}::variant::${endpoint.providerSlug}`,
    providerSlug: 'vercel',
    routerLabel: ROUTER_LABELS.vercel,
    providerLabel,
    wireSlug,
    canonicalSlug: `vercel::${wireSlug}`,
    displayName: wireSlug,
    inputPrice: endpoint.inputPricePerM,
    outputPrice: endpoint.outputPricePerM,
    family,
    variantSlug: endpoint.providerSlug,
    variantUptime: endpoint.uptimePct1h,
    isVariant: true,
    searchText: [wireSlug, family, 'vercel', endpoint.providerSlug, providerLabel].join(' ').toLowerCase(),
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
// tweet-demo pairs we hand-seeded. Fast/turbo variants get their own key so
// they don't share standard-tier pricing.
function tryDirectPriceKey(providerSlug: string, wireSlug: string): string | null {
  if (!(providerSlug in DIRECT_PRICING)) return null;
  const s = wireSlug.toLowerCase();
  const isFast = /(-|\.)fast\b|k3p_?fast|kimi-k3-fast|glm-5p2-fast|5\.2-fast/.test(s);
  if (s.includes('kimi') && (s.includes('k3') || s.includes('k3p') || s.includes('k3-'))) {
    return isFast ? 'moonshotai/kimi-k3-fast' : 'moonshotai/kimi-k3';
  }
  if (s.includes('glm') && (s.includes('5.2') || s.includes('5p2'))) {
    return isFast ? 'z-ai/glm-5.2-fast' : 'z-ai/glm-5.2';
  }
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
