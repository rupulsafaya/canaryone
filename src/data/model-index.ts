// UnifiedModel index — merges the OR catalog with per-provider catalogs so
// PickModels / PickDestinations can render one row per canonical model with
// N routes attached.
//
// A7 lean scope: exposes `directDestinationsFor(canonicalSlug, catalogs)` so
// PickDestinations can APPEND direct-provider routes to the existing OR
// endpoint list without rewriting the whole screen. Full UnifiedModel
// rewrite of PickModels lands in a follow-up.

import { DIRECT_PROVIDERS, DIRECT_PRICING, type DirectEntry } from '../proxy/providers.js';
import type { ProviderCatalogs } from '../scan/provider-catalog.js';
import type { Destination } from './fixtures.js';

export interface DirectRoute {
  providerSlug: string;               // e.g. 'direct:moonshot-intl'
  providerNativeSlug: string;         // raw catalog slug (wire slug)
  entry: DirectEntry;
}

/**
 * List every configured direct-provider that has a raw slug canonicalizing to
 * `canonicalSlug`. Returns an empty array if no provider-catalogs.json entries
 * yet, or if no direct catalog knows this model.
 */
export function directRoutesFor(
  canonicalSlug: string,
  catalogs: ProviderCatalogs,
): DirectRoute[] {
  const routes: DirectRoute[] = [];
  for (const entry of DIRECT_PROVIDERS) {
    if (entry.status !== 'shipped') continue;
    const cat = catalogs[entry.slug];
    if (!cat) continue;
    const raw = Object.entries(cat.canonical_map).find(([, canon]) => canon === canonicalSlug)?.[0];
    if (raw) {
      routes.push({ providerSlug: entry.slug, providerNativeSlug: raw, entry });
    }
  }
  return routes;
}

/**
 * Adapter — turn a DirectRoute into the Destination shape PickDestinations
 * already renders. Pricing pulled from DIRECT_PRICING when available; missing
 * entries render as 0 (report will show '—' downstream).
 */
export function directRouteToDestination(
  route: DirectRoute,
  canonicalSlug: string,
): Destination {
  const price = DIRECT_PRICING[route.providerSlug]?.[canonicalSlug] ?? { input: 0, output: 0 };
  // First-party heuristic: destination provider owns the model family.
  // e.g. 'moonshot-intl' is first-party for `moonshotai/*` models.
  const family = canonicalSlug.split('/')[0].toLowerCase();
  const providerName = route.entry.slug.replace(/^direct:/, '').split('-')[0];
  const isFirstParty = family.startsWith(providerName);
  return {
    slug: route.providerSlug,           // stored as-is in selectedDestinations
    router: 'direct',
    provider: route.entry.displayName,
    displayName: route.entry.displayName,
    inputPrice: price.input,
    outputPrice: price.output,
    isFirstParty,
    isPreview: false,
  };
}

/**
 * Ordering helper — first-party direct routes ahead of others, then alphabetical.
 * Used by PickDestinations when it appends direct routes to the OR list.
 */
export function orderDirectDestinations(destinations: Destination[]): Destination[] {
  return [...destinations].sort((a, b) => {
    if (a.isFirstParty !== b.isFirstParty) return a.isFirstParty ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}
