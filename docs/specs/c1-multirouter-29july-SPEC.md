# canaryone SPEC 3 — Multi-router forwarding + API keys screen

**Status:** proposed 2026-07-29 (session `c1-bld2907-repv1`). Supersedes Part A of [`c1-launch-29july-SPEC.md`](./c1-launch-29july-SPEC.md) with concrete decisions from the interview round. Part B (judge) is already shipped as of `main @ aa7dd01`.

**Parent SPECs:**
- [`c1-launch-29july-SPEC.md`](./c1-launch-29july-SPEC.md) — Part A of that doc is now REPLACED by this one; Part B (judge) shipped.
- [`c1-runner-28july-SPEC.md`](./c1-runner-28july-SPEC.md) — original runner SPEC.

---

## 1. Purpose

Extend canaryone from single-router (OpenRouter) to multi-router benchmarking:

- **New routers:** Vercel AI Gateway, Cloudflare AI Gateway (both OpenAI-compat).
- **Direct providers:** Moonshot, Nebius, Fireworks, Together, Groq, DeepSeek, Cerebras (all OpenAI-compat, BYOK).
- **New TUI screen:** `API keys` — replaces `KeySetup`, manages tokens for all 11 providers in one place.
- **Model catalog discovery:** on paste, we `GET /v1/models` per provider and cache the returned list. PickModels then shows the union of catalogs across configured providers.
- **Slug reconciliation:** a canonical family/variant slug computed via one-shot Haiku disambiguation on catalog ingest, so `moonshotai/kimi-k3` on OR and `kimi-k3-preview` on Moonshot direct resolve to the same comparable model.

Together this ships the tweet narrative: *"canaryone tests any model across OR routes AND direct providers OR won't route to."*

## 2. Non-goals

- Anthropic native inbound + translator (deferred to D3 — not needed while all supported providers are OpenAI-compat).
- Streaming / tool round-trip (D5).
- Bedrock direct destinations (`— coming soon` in the screen, but plumbing not shipped; targeted for v0.2).
- Vertex AI / Azure OpenAI direct routing (v0.2+).
- Automatic price scraping — pricing table remains hand-maintained (see §12).
- Vercel Gateway underlying-provider disclosure (Vercel doesn't expose which provider served a given request; we render `provider=(internal)` and move on — see §11).

## 3. Invariants (unchanged from parent)

1. canaryone never writes to a file inside the target repo except `<targetDir>/.c1/`.
2. Env-var-swap capture only. No MITM.
3. Zero-default pickers stay zero-default (user must explicitly select ≥1 model + ≥1 destination).
4. `--start <screen>` demo paths keep working.
5. **NEW:** OpenRouter is the only *required* provider. Everything else is optional. A user with only an OR key gets today's behavior.
6. **NEW:** PickModels shows only models covered by ≥1 configured provider's catalog. No orphan models possible.

---

## 4. Router + provider registry

canaryone's destination slug is `<router>:<provider>[/<variant>]`. Four routers ship in this SPEC:

- **`openrouter:*`** — already shipped in D2; unchanged.
- **`vercel:<model>`** — Vercel AI Gateway. One lane per model; gateway routes internally, so `provider=(internal)`.
- **`cloudflare:<model>`** — Cloudflare AI Gateway. Requires per-user `account_id` + `gateway_id` on top of the token; `— partial config` in the screen until all three fields are present.
- **`direct:<provider>`** — first-party provider APIs. The core differentiator vs OR's tool.

### 4.1 Router registry (in `src/proxy/providers.ts`)

| slug prefix | displayName | forwardUrl template | authEnv | requires | validation endpoint |
|---|---|---|---|---|---|
| `openrouter:` | OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` | key | `GET /api/v1/credits` |
| `vercel:` | Vercel AI Gateway | `https://gateway.ai.vercel.app/v1/chat/completions` | `VERCEL_AI_GATEWAY_TOKEN` | key | `GET /v1/models` |
| `cloudflare:` | Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{CF_GATEWAY_ID}/openai/chat/completions` | `CF_AI_GATEWAY_TOKEN` | key + `CF_ACCOUNT_ID` + `CF_GATEWAY_ID` | `GET /accounts/{CF_ACCOUNT_ID}/ai-gateway/gateways/{CF_GATEWAY_ID}` |

### 4.2 Direct-provider registry

| slug | displayName | forwardUrl | apiKeyEnvVar | validation | catalog endpoint |
|---|---|---|---|---|---|
| `direct:moonshot-intl` | Moonshot AI (intl) | `https://api.moonshot.ai/v1/chat/completions` | `MOONSHOT_API_KEY` | `GET /v1/models` | same |
| `direct:moonshot-cn` | Moonshot AI (cn) | `https://api.moonshot.cn/v1/chat/completions` | `MOONSHOT_API_KEY` (shared) | `GET /v1/models` | same |
| `direct:nebius` | Nebius | `https://api.studio.nebius.ai/v1/chat/completions` | `NEBIUS_API_KEY` | `GET /v1/models` | same |
| `direct:fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1/chat/completions` | `FIREWORKS_API_KEY` | `GET /v1/accounts` | `GET /inference/v1/models` |
| `direct:together` | Together AI | `https://api.together.xyz/v1/chat/completions` | `TOGETHER_API_KEY` | `GET /v1/models` | same |
| `direct:groq` | Groq | `https://api.groq.com/openai/v1/chat/completions` | `GROQ_API_KEY` | `GET /openai/v1/models` | same |
| `direct:deepseek` | DeepSeek | `https://api.deepseek.com/chat/completions` | `DEEPSEEK_API_KEY` | `GET /v1/models` | same |
| `direct:cerebras` | Cerebras | `https://api.cerebras.ai/v1/chat/completions` | `CEREBRAS_API_KEY` | `GET /v1/models` | same |

**Moonshot intl + cn share `MOONSHOT_API_KEY`** — one row in the API keys screen labelled "Moonshot (intl + cn)". The two lane slugs remain distinct at run time so users can compare intl vs cn latency.

---

## 5. API keys screen (replaces KeySetup)

New file `src/screens/ApiKeys.tsx` — grouped list of every provider. Shipped as the first screen in the flow.

### 5.1 Layout

```
canaryone · API keys                              3 of 11 providers configured
───────────────────────────────────────────────────────────────────────────────
Routers
▸ OpenRouter                ✓ set (~/.c1/.env)      $18.42 credits · validated
  Vercel                    — missing               [p] paste token
  Cloudflare                — partial config        [p] paste (needs token +
                                                      account_id + gateway_id)
  Bedrock                   — coming soon           (grey)

Direct Providers
  Moonshot (intl + cn)      ✓ set (~/.c1/.env)      validated 2s ago
  Nebius                    — missing               [p] paste token
  Fireworks                 — missing               [p] paste token
  Together                  — missing               [p] paste token
  Groq                      ✓ set (~/.c1/.env)      validated 2s ago
  DeepSeek                  — missing               [p] paste token
  Cerebras                  — missing               [p] paste token
  More coming soon                                  (grey)

───────────────────────────────────────────────────────────────────────────────
[↑↓] navigate  [p] paste  [d] delete  [r] refresh catalog  [enter] continue
                          (OR required)  [q] quit
```

### 5.2 Behavior

- **Row status vocabulary:**
  - `✓ set (~/.c1/.env)` — token present in dotenv, will be used at run time.
  - `✓ set (env:$VAR)` — token comes from shell environment (takes precedence over dotenv).
  - `✓ set (~/.c1/.env) · validated Ns ago` — token present AND `/v1/models` returned 200 within this session.
  - `✓ set (~/.c1/.env) · unverified` — token saved but validation network call failed (5xx / offline). Not a hard failure; run will attempt to use it.
  - `— missing` — no token found.
  - `— partial config` — for Cloudflare: token present but `account_id` and/or `gateway_id` missing.
  - `— coming soon` — grey, not navigable (Bedrock; the trailing "More coming soon" row).
- **`p` — paste flow (single-field providers):**
  - Prompt: `Paste <ENV_VAR>: [___________]`
  - Trim whitespace + strip surrounding quotes.
  - Immediately run the validation call (see §6). On 200, save to `~/.c1/.env` and update row status + fetch catalog.
  - On 401/403, do NOT save; show error inline (`✗ rejected · 401 invalid_api_key`).
  - On network error, save with `— unverified` status.
- **`p` — paste flow (Cloudflare):** sequential 3-step inline prompts: token → account_id → gateway_id. Validation runs only after all three are present.
- **`d` — delete:** removes the env-var line(s) from `~/.c1/.env` and the row's cached catalog from `~/.c1/provider-catalogs.json`. Prompts for confirmation.
- **`r` — refresh catalog:** re-hits `/v1/models` for the highlighted row (or all rows if pressed with no row focused). Useful when a provider adds new models.
- **`enter` — advance:** to Onboarding. Blocked when OR is missing; footer text updates: `enter (OR required)` becomes `enter continue →`.
- **`q` / `esc` — quit.**

### 5.3 Multi-line paste hygiene

Users paste from browser tabs. Common issues:
- Trailing newline / whitespace → strip.
- Surrounding quotes (`"sk-..."`) → strip.
- Multi-line paste (someone pastes a JSON blob) → reject with inline error `paste must be a single-line token`.

---

## 6. Validation on paste

Every paste triggers a synchronous validation call (per §4.1 / §4.2 tables). The pattern:

```ts
async function validate(providerSlug: string, token: string): Promise<'ok' | 'rejected' | 'unverified'> {
  const provider = getProvider(providerSlug);
  try {
    const res = await fetch(provider.validationUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 200) return 'ok';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unverified';   // 5xx, weird status codes — save-and-hope
  } catch {
    return 'unverified';   // network error, timeout — save-and-hope
  }
}
```

On `'ok'` we also cache the response body (for the catalog — see §7).

For OpenRouter, we use `/api/v1/credits` instead of `/v1/models` because it also returns balance info we render in the row status.

---

## 7. Model catalog discovery + cache

### 7.1 Cache file

`~/.c1/provider-catalogs.json` — one entry per configured provider. TTL 24 hours; `[r]` forces refresh.

```jsonc
{
  "openrouter": {
    "fetched_at": "2026-07-29T10:22:52Z",
    "models_raw": ["openai/gpt-4o", "moonshotai/kimi-k3", "z-ai/glm-5.2", ...],
    "canonical_map": {
      "openai/gpt-4o":       "openai/gpt-4o",
      "moonshotai/kimi-k3":  "moonshotai/kimi-k3",
      "z-ai/glm-5.2":        "z-ai/glm-5.2"
      // OR uses canonical slugs already; identity map for it
    }
  },
  "moonshot": {
    "fetched_at": "2026-07-29T10:22:53Z",
    "models_raw": ["kimi-k3-preview", "kimi-k2", "moonshot-v1-32k"],
    "canonical_map": {
      "kimi-k3-preview":     "moonshotai/kimi-k3",
      "kimi-k2":             "moonshotai/kimi-k2",
      "moonshot-v1-32k":     "moonshotai/moonshot-v1-32k"
    }
  }
}
```

### 7.2 Ingest pipeline

When a new token validates, or when the user hits `[r]`:

1. `GET {catalogEndpoint}` with the token. Parse `data[].id` from the response — that's the raw model list.
2. Hit Haiku 4.5 once with the raw list:
   ```
   System: You normalise LLM model identifiers to a canonical `family/variant` slug.
     Input: a list of provider-native model slugs.
     Output: JSON map — one entry per input, value is the canonical slug.
     Canonical form: lowercase, hyphenated, in the form `<owner>/<model>-<variant>`
     following OpenRouter's convention where possible. Preserve version numbers.
     Group aliases: 'kimi-k3-preview' and 'moonshotai/Kimi-K3-Instruct' both map
     to 'moonshotai/kimi-k3'. When uncertain, keep the provider's slug verbatim.
   User: [ list of raw slugs ]
   ```
3. Cost: ~$0.005 per catalog refresh. Not per session — per token paste + per user-triggered `[r]`.
4. On Haiku error, fall back to identity map (raw slug === canonical); the report will show the two slugs as separate models, which is honest degradation.

### 7.3 Union view

`src/data/model-index.ts` (new) exports:

```ts
export interface UnifiedModel {
  canonicalSlug: string;               // e.g. "moonshotai/kimi-k3"
  displayName: string;                 // best-guess from OR catalog if available; else canonical
  family: string;                      // "moonshotai" (color-code by this)
  routes: Array<{
    providerSlug: string;              // "openrouter" | "vercel" | "moonshot" | ...
    providerNativeSlug: string;        // "kimi-k3-preview"
  }>;
}

export function buildModelIndex(catalogs: ProviderCatalogs): UnifiedModel[];
```

PickModels reads `UnifiedModel[]`. Row shows displayName + a small badge with route count: `Kimi K3   [3 routes]`. Search + rankings + presets work the same way they do today; the only change is the data source.

---

## 8. LaneSpec extension

Extend `src/runner/orchestrator.ts:LaneSpec`:

```ts
export interface LaneSpec {
  // Existing:
  modelSlug: string;                   // canonical slug — the KEY
  destinationSlug: string;             // e.g. "direct:moonshot-intl" or "openrouter:baseten/fp8"
  router: string;                      // "openrouter" | "direct" | "vercel" | "cloudflare"
  providerTag: string | null;          // "baseten/fp8" for OR; null for direct/vercel/cloudflare
  endpoint: OrEndpoint | null;         // OR pricing hydrate — null for non-OR
  fallbackModelPrice: { input: number; output: number } | null;

  // NEW (Part A):
  forwardUrl: string;                  // resolved from providers registry at store.startRun
  apiKey: string;                      // resolved from ~/.c1/.env at store.startRun
  modelSlugForForward: string;         // per-provider native slug (may differ from canonical)
}
```

`RunSpec.orKey` becomes redundant (`orKey === direct-openrouter's apiKey`). Kept for backwards compat during migration; deprecated after this ships.

## 9. lane.ts changes

`src/proxy/lane.ts:handleChatCompletions`:

- Replace hard-coded `OR_URL` with `cfg.forwardUrl`.
- Replace `authorization: Bearer ${cfg.orKey}` with `${cfg.apiKey}`.
- Set `body.model = cfg.modelSlugForForward` (not `cfg.modelSlug` — the canonical slug isn't always the wire slug).
- Skip the `provider.order` rewrite when `cfg.router !== 'openrouter'` — direct/vercel/cloudflare don't know OR's provider-routing metadata.
- Cost math: `computeCost` already reads `cfg.endpoint ?? cfg.fallbackModelPrice`. For direct providers we populate `fallbackModelPrice` from `DIRECT_PRICING` (§12) at `store.startRun` time. When neither is set, `computeCost` returns 0 and the report renders cost as `—` (fail-soft per SPEC 1 Part A interview).

## 10. Store wiring

`src/state/store.ts:startRun`:

1. Load `~/.c1/.env` + `~/.c1/provider-catalogs.json`.
2. For each `LaneSpec` being built:
   - Look up `destinationSlug` in the router / provider registry.
   - Populate `forwardUrl`, `apiKey`, `modelSlugForForward`.
   - Look up `DIRECT_PRICING[destinationSlug]?.[modelSlug]` — populate `fallbackModelPrice` (or leave null → fail-soft cost).
3. If any lane's `apiKey` is empty → throw `Error('missing API key for <destinationSlug>. Configure on API keys screen (--start apiKeys).')` — this shouldn't happen in practice because PickDestinations only shows lanes for providers with keys.

## 11. PickModels + PickDestinations rewire

**PickModels** now reads from `buildModelIndex(catalogs)` instead of the OR catalog directly:

- Union across all configured providers, deduplicated by canonical slug.
- Search / preset / rankings continue to work as today — the OR catalog is still the source of `rankPosition` + `totalTokens` for the sort.
- Route count badge per row so users see how many providers serve each model.
- Models only served by direct providers (not OR) still appear — just without an OR rank position.

**PickDestinations** now shows the routes for the selected model:

- For each model the user picked, list its `.routes[]` (from `UnifiedModel`).
- Each route → one row. Format: `<router-badge> <providerNativeSlug>` with the shared canonical-slug already implicit from the model selection.
- OR routes still expand via `/models/{slug}/endpoints` (existing behavior) for per-provider variants.
- Vercel / Cloudflare rows expand to `<gateway>:<model>` — one destination each; provider = internal.
- Direct provider rows: `direct:<providerSlug>`.
- Same zero-default invariant.

Ordering:
1. First-party direct (Moonshot for Kimi, DeepSeek for DeepSeek) — starred.
2. Other direct providers, alphabetical.
3. Gateway routes (Vercel, Cloudflare).
4. OR routes, sorted by provider first-party status → uptime desc → price asc (existing).

## 12. Direct-provider pricing

Hard-coded table in `src/proxy/providers.ts`:

```ts
export const DIRECT_PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  'direct:moonshot-intl': {
    'moonshotai/kimi-k3': { input: 2.50, output: 12.50 },
    // ...
  },
  'direct:nebius': {
    'moonshotai/kimi-k3': { input: 2.80, output: 14.00 },
    // ...
  },
  // ...
};
```

Missing entries → `fallbackModelPrice = null` → `computeCost` returns 0 → report renders `—` in `$/pass` and `weighted $/pass` columns for that lane. All other columns (pass rate, latency, judge score) work normally.

Maintenance: update by hand when a new (provider, model) pair enters the tweet demo. Auto-scraping deferred to v0.1.

## 13. Mid-run auth failure

If a direct-provider lane returns 401 during a run:

- `src/proxy/lane.ts` sets `failure_class='auth_failed'` on the step.
- `src/runner/orchestrator.ts` observes: after the FIRST `auth_failed` on a lane, mark all remaining queued sessions for that (lane, task) as `failed` (before they spawn) with `failure_class='auth_failed'`. LiveProgress cells fill red.
- Other lanes continue unaffected.
- Post-run summary + HTML report surface the killed lane's failure_class prominently.

Implementation: an `abortedLaneKeys: Set<string>` on `RunEngine`, checked at worker-loop pickup. Simple; no cross-worker coordination beyond the set.

## 14. Non-secret Cloudflare config

Cloudflare's `account_id` and `gateway_id` aren't secrets, but they live in `~/.c1/.env` alongside the token — one file, easier UX. TokenManager treats the row as one unit (`— partial config` when any field is missing).

## 15. Testing

### 15.1 Pty scenarios (extend `tests/tui.test.mjs`)

- **N.** `--start apiKeys` renders 11 rows in two groups; OR row shows OR_KEY status; navigating up/down skips grey rows.
- **O.** `--start apiKeys` paste-flow: send `p` → send test token → assert `— missing` flips to `✓ set (~/.c1/.env)` (test double for validation endpoint returns 200).
- **P.** `--start apiKeys` cloudflare 3-step: send `p` → token → enter → account_id → enter → gateway_id → enter → row shows fully configured.
- **Q.** `--start pickModels` with 2 catalogs loaded → assert both OR-only models and direct-only models appear.
- **R.** `--start pickDestinations` with Kimi K3 selected → assert direct:moonshot-intl + direct:nebius rows present + starred → space-toggle a direct → advance to Confirm.

### 15.2 Unit tests

- `src/proxy/providers.test.mjs` — registry lookup, `remapModelForProvider`, `DIRECT_PRICING` fallthrough.
- `src/scan/provider-catalog.test.mjs` — 24h TTL logic, canonical-map ingest with a mocked Haiku response.

### 15.3 Integration (extend `tests/runner.test.mjs`)

- Add a second lane: `direct:moonshot-intl` (skipped if `MOONSHOT_API_KEY` unset in `~/.c1/.env`). Run one echo test. Assert traffic captured + judge tags written + `sessions.router='direct'` for that session.

Skip live cost: gate the direct-provider lane behind `process.env.MOONSHOT_API_KEY` presence so CI without a Moonshot key still runs the OR-only path.

## 16. Exit criterion

Success = the following `c1 run` completes end-to-end:

- **Target:** demo repo (job-search-automation or similar with real multi-turn agent test).
- **Model:** `moonshotai/kimi-k3` (or GLM 5.2, whichever the tweet demo uses).
- **Lanes (4):**
  1. `openrouter:moonshotai` — Moonshot via OR
  2. `openrouter:baseten/fp8` — Baseten via OR
  3. `direct:moonshot-intl` — Moonshot's direct API
  4. `direct:nebius` — Nebius direct
- **Repeats:** 2.
- **Sessions total:** 16–24.
- **Expected cost:** ~$0.30 destination + ~$0.10 judge ≈ **$0.40**.

Success signals (in addition to shipped judge behavior):
- All 4 lanes have non-null cost_usd (populated via OR catalog for OR lanes, DIRECT_PRICING for direct lanes).
- `sessions.router` distinguishes `openrouter` vs `direct`.
- Report lane table shows all 4 rows with correct router badges (OR / DIR).
- HTML report renders judge scores across all 4 lanes; direct routes visible in the aggregate "cheapest raw" / "best value" callouts.
- The Groq-style callout (if used): a direct lane wins raw $/pass but shows narrated ⚠ — proves the metric OR's tool can't compute.

## 17. Rollout order

Suggested milestones (matching the J1–J8 pattern of Part B's kickoff):

- **A1.** `src/proxy/providers.ts` — registry + DIRECT_PRICING + getters (~1h).
- **A2.** `.env` read/write helpers extended for multi-provider — `src/scan/env-file.ts` (~1h).
- **A3.** `src/scan/provider-catalog.ts` — validation call, catalog fetch, Haiku canonicalization, TTL cache (~2-3h).
- **A4.** `src/screens/ApiKeys.tsx` — the new screen replacing KeySetup (~3-4h; big screen, lots of interactive states).
- **A5.** LaneSpec extension + `src/proxy/lane.ts` forwarding changes (~1-2h).
- **A6.** Store wiring — populate new fields, delete KeySetup references, add ApiKeys as first screen (~1-2h).
- **A7.** `src/screens/PickModels.tsx` + `PickDestinations.tsx` rewire to consume `UnifiedModel[]` (~2-3h).
- **A8.** Mid-run auth-failure handling in orchestrator (~1h).
- **A9.** Integration test + pty scenarios + regression (~2h).

Total estimate: **~15–20 hours**. Ship on `main` incrementally as A1..A9 commits.

## 18. Provenance

- Interview session `c1-bld2907-repv1`, 2026-07-29.
- Supersedes Part A of `c1-launch-29july-SPEC.md` (§3–§8 of that doc).
- Reference judge: shipped `main @ aa7dd01`.
