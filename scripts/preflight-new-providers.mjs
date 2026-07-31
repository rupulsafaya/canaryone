// One-shot script: runs the real probeLane() from preflight.ts against each
// new direct provider added 2026-07-31, using real keys from ~/.c1/.env.
// This is the "M3 preflight-must-be-green-on-real-key" gate per the direct-
// providers spec. Run with `node scripts/preflight-new-providers.mjs`.
//
// Not a repeatable test — one-off validation before flipping status='shipped'.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const canaryoneDir = new URL('..', import.meta.url).pathname;
const providers = await import(
  pathToFileURL(path.join(canaryoneDir, 'src/proxy/providers.ts')).href
);
const preflight = await import(
  pathToFileURL(path.join(canaryoneDir, 'src/proxy/preflight.ts')).href
);

const CASES = [
  { slug: 'direct:openai',        model: 'gpt-4o-mini' },
  { slug: 'direct:anthropic',     model: 'claude-sonnet-4-6' },
  { slug: 'direct:deepseek',      model: 'deepseek-v4-flash' },
  { slug: 'direct:xai',           model: 'grok-4.3' },
  { slug: 'direct:google-gemini', model: 'gemini-3.6-flash' },
];

for (const c of CASES) {
  const entry = providers.getProvider(c.slug);
  if (!entry) { console.log(`SKIP ${c.slug} — not in registry`); continue; }
  const key = await providers.getApiKey(c.slug);
  if (!key.value) { console.log(`SKIP ${c.slug} — no API key in env`); continue; }
  const lane = {
    router: 'direct',
    forwardUrl: entry.forwardUrl,
    apiKey: key.value,
    modelSlug: c.model,
    modelSlugForForward: c.model,
    providerTag: null,
  };
  const r = await preflight.probeLane(lane);
  const marker = r.ok ? '✅' : '❌';
  console.log(`${marker} ${c.slug} (${c.model}): ${r.category} ${r.httpStatus} ${r.latencyMs}ms — ${r.message}`);
}
