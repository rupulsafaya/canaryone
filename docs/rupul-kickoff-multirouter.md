# Kickoff prompt — SPEC 3 (multi-router + API keys screen)

**How to use:** open a fresh Claude Code session in the canaryone repo root, paste everything between the `───` markers below into the first message. Read the SPEC alongside while Claude works.

**Scope:** SPEC 3 (multi-router + API keys screen) ONLY. This supersedes Part A of `c1-launch-29july-SPEC.md`. Part B of that SPEC (judge) has already shipped and MUST NOT be touched.

---

You are implementing `c1-multirouter-29july-SPEC.md` in the canaryone repo. This SPEC extends canaryone from single-router (OpenRouter) to multi-router benchmarking — Vercel, Cloudflare, and 8 direct providers (Moonshot, Nebius, Fireworks, Together, Groq, DeepSeek, Cerebras). It also ships a new TUI screen `ApiKeys` that replaces the current `KeySetup`.

Part B of the parent SPEC (the Haiku judge) is ALREADY SHIPPED and MUST NOT be touched. Do not modify:
  - src/judge/**
  - src/db/sqlite.ts schema (unless you need a new column — file an issue instead)
  - src/runner/{orchestrator,print-summary,traffic-log,worktree,subprocess}.ts
    (Except for the small LaneSpec / auth-fail changes explicitly called out in SPEC §8, §13.)
  - src/report/** (SPEC 2 is a separate track owned by Bhaskar)

If you touch anything outside the files listed in §4–§13 of the SPEC, stop and re-read the SPEC to confirm you should.

────────────────────────────────────────────────────────────────────────────
CURRENT STATE OF THE REPO (2026-07-29, main @ aa7dd01)
────────────────────────────────────────────────────────────────────────────

Shipped (do NOT rebuild):
- D1 (methodology detection) — src/scan/methodology.ts
- D2 (base runner) — proxy/lane.ts + runner/{orchestrator,subprocess,worktree,
  traffic-log,event-bus}.ts + db/sqlite.ts
- SPEC 1 Part B (judge) — src/judge/{trajectory,subscores,git-diff,haiku-r5,
  worker}.ts + prompt-haiku-r5-local.md. 8 classifier_tags per session in
  db.sqlite. Auto-generated at end of every run.
- SPEC 2 Phase 0 + Phase 1 (HTML report) — src/report/**. Auto-generated
  at end of every run; `enter` on LiveProgress opens it in the default browser.
- TUI polish — .env propagation, run:sessionsComplete split, live subtitle
  tick from session:step, pass column shows passed/expected during a run,
  SummarizeTasks overflow fix, tasks_meta written by orchestrator.

Regression signal (must stay green throughout):
  npx tsc --noEmit       # exit 0
  pnpm test:tui          # 13 pty scenarios, currently green
  pnpm test:judge        # trajectory + subscores unit tests
  pnpm test:runner       # integration test — judge tags + report gen + summary

────────────────────────────────────────────────────────────────────────────
READ FIRST (in order)
────────────────────────────────────────────────────────────────────────────

1. `c1-multirouter-29july-SPEC.md` — the SPEC in full. Every section matters.
   §5 (API keys screen), §7 (catalog cache), §8 (LaneSpec extension), §11
   (PickModels/PickDestinations rewire) carry the most novel design.

2. Existing shipped code you will touch or reference:
   - src/screens/KeySetup.tsx        — the screen you're replacing.
   - src/screens/PickModels.tsx      — will read from unified model index.
   - src/screens/PickDestinations.tsx — will show routes per selected model.
   - src/proxy/lane.ts               — swap hard-coded OR_URL for cfg.forwardUrl.
   - src/runner/orchestrator.ts      — LaneSpec extension; auth-fail handling.
   - src/state/store.ts              — load .env, populate LaneSpec fields.
   - src/scan/or-catalog.ts          — pattern to follow for catalog cache
                                        (~/.c1/or-catalog.json — same shape family).
   - src/scan/orchestrator.ts        — where OR key detection lives today.

3. Files you'll create:
   - src/proxy/providers.ts          — registry + DIRECT_PRICING.
   - src/scan/env-file.ts            — read/write helpers for ~/.c1/.env.
   - src/scan/provider-catalog.ts    — validation, catalog fetch, Haiku
                                        canonicalize, TTL cache.
   - src/data/model-index.ts         — UnifiedModel builder from catalogs.
   - src/screens/ApiKeys.tsx         — new screen (replaces KeySetup).

────────────────────────────────────────────────────────────────────────────
GATES / INVARIANTS
────────────────────────────────────────────────────────────────────────────

- **OpenRouter remains required.** A user with only OR configured gets today's
  behavior — the screen just has more rows. `enter` is blocked without OR.

- **Zero-default pickers stay zero-default.** User must explicitly select
  ≥1 model + ≥1 destination. Adding new providers doesn't change this.

- **PickModels shows only models covered by ≥1 configured provider's catalog.**
  No orphan models. This is a structural invariant — the union of catalogs
  defines the model space.

- **DB schema is UNCHANGED.** No migration. LaneSpec extensions live in memory
  + `runs.meta_json`. `sessions.router` is a plain TEXT column that will now
  carry `openrouter` | `direct` | `vercel` | `cloudflare` instead of just
  `openrouter`.

- **Fail-soft on missing pricing.** DIRECT_PRICING has gaps. When a lane's
  (provider, model) isn't in the table, `fallbackModelPrice = null` and the
  report renders `—` in cost columns. All other columns work.

- **Fail-hard on missing API key at run time.** Should never happen (PickDestinations
  filters unavailable providers), but if it does, throw with a clear "add key
  on API keys screen" message.

- **Eager token validation.** On paste, `GET /v1/models` (or provider-specific
  validation endpoint per §4.1/§4.2) with 5s timeout. 200 → save + fetch
  catalog. 401/403 → reject, don't save. Network error → save with `unverified`
  status (don't punish flaky wifi).

- **Haiku canonicalization is one-shot per catalog refresh**, not per session.
  Cost ceiling: ~$0.005 per token paste + ~$0.005 per user-triggered [r]. If
  it errors, fall back to identity map (raw slug === canonical) — honest
  degradation, models will just appear twice under different slugs.

- **Mid-run auth failure kills the lane, not the run.** First 401 on a lane
  marks all remaining queued sessions for that lane as `failure_class='auth_failed'`.
  Other lanes proceed.

────────────────────────────────────────────────────────────────────────────
ORDER OF IMPLEMENTATION
────────────────────────────────────────────────────────────────────────────

Ship on `main` incrementally. Each milestone is a commit.

**Milestone A1: providers.ts registry** (~1h)
  - src/proxy/providers.ts (new): ROUTER_REGISTRY, DIRECT_REGISTRY,
    DIRECT_PRICING (start with just Kimi K3 + GLM 5.2 entries).
  - Exports: getProvider(slug), getRouterMeta(slug), listAllProviders(),
    getApiKey(providerSlug) → reads process.env then ~/.c1/.env fallback.
  - Unit test: registry lookup, precedence (process.env > .env file).

**Milestone A2: env file helpers** (~1h)
  - src/scan/env-file.ts (new): readEnvFile(path), writeEnvVar(path, key, value),
    deleteEnvVar(path, key). All operate on ~/.c1/.env.
  - Preserve comments + ordering when rewriting. Use one line per KEY=VALUE.
  - Unit test: read + write + delete round-trip, comment preservation.

**Milestone A3: provider catalog fetcher + canonicalizer** (~2-3h)
  - src/scan/provider-catalog.ts (new):
    - fetchModels(providerSlug, token) → { rawSlugs: string[] }
    - canonicalizeSlugs(rawSlugs, judgeKey) → Record<raw, canonical> via Haiku
    - loadCatalogs(configDir) / writeCatalogs(configDir, ...) — ~/.c1/provider-catalogs.json
    - refreshCatalog(providerSlug, token, configDir) — fetch + canonicalize + persist
    - isStale(entry, ttlMs = 24h)
  - Unit test with mocked fetch + mocked Haiku response.

**Milestone A4: ApiKeys screen** (~3-4h)
  - src/screens/ApiKeys.tsx (new). Layout per §5.1.
  - Uses providers.ts registry to enumerate rows.
  - Row status derived from getApiKey() + validation timestamp in memory.
  - Keyboard: ↑↓ p d r enter q. Grey rows (Bedrock, "more coming soon")
    skipped by nav.
  - Cloudflare 3-step paste as its own inline state machine.
  - On successful paste: run validate() from §6 → on 200, save + trigger
    async refreshCatalog() (don't block UI on the Haiku call; show
    "fetching catalog…" transient status, then update row when done).
  - Delete: confirmation prompt (y/n) before removing from .env.
  - `[r]` on a row: refresh just that catalog. `[R]` (shift-R) on any row:
    refresh all configured catalogs.
  - Pty scenarios N/O/P (SPEC §15.1) added to tests/tui.test.mjs.

**Milestone A5: LaneSpec + lane.ts** (~1-2h)
  - src/runner/orchestrator.ts: extend LaneSpec with forwardUrl / apiKey /
    modelSlugForForward. `RunSpec.orKey` kept for compat but unused.
  - src/proxy/lane.ts: replace OR_URL with cfg.forwardUrl. Replace cfg.orKey
    with cfg.apiKey. Set body.model = cfg.modelSlugForForward. Skip provider.order
    for non-openrouter routers.
  - No test changes yet — just make it typecheck + not regress test:runner.

**Milestone A6: store wiring + delete KeySetup** (~1-2h)
  - src/state/store.ts:startRun: populate new LaneSpec fields from providers.ts
    registry + env-file.ts + catalog canonical map.
  - src/App.tsx / src/cli.tsx: replace KeySetup with ApiKeys as first screen.
  - Delete src/screens/KeySetup.tsx.
  - Update any `screen === 'keySetup'` references.
  - test:tui should still pass (may need to update the KeySetup pty scenarios
    to reference ApiKeys — do this deliberately).

**Milestone A7: PickModels + PickDestinations rewire** (~2-3h)
  - src/data/model-index.ts (new): buildModelIndex(catalogs) → UnifiedModel[].
  - src/screens/PickModels.tsx: source data changes from OR catalog only to
    buildModelIndex output. Keep search / rankings / preset logic identical.
    Add "N routes" badge per row.
  - src/screens/PickDestinations.tsx: for each selected model, show its
    .routes[]. Ordering per SPEC §11. First-party stars preserved.
  - Pty scenarios Q/R added.

**Milestone A8: mid-run auth failure** (~1h)
  - src/runner/orchestrator.ts: add abortedLaneKeys: Set<string>. On
    session:failed with failure_class='auth_failed', add the lane's key.
    Worker loop skips sessions whose lane is in the set (marks them failed
    pre-spawn with same failure_class).
  - Unit test in tests/runner.test.mjs by mocking a 401 from the lane proxy.

**Milestone A9: integration + regression** (~2h)
  - Extend tests/runner.test.mjs: if MOONSHOT_API_KEY exists in ~/.c1/.env,
    add a direct:moonshot-intl lane. Assert traffic captured, judge tags
    written, sessions.router='direct' for that session.
  - Full regression pass:
      npx tsc --noEmit    # exit 0
      pnpm test:tui       # 13+ scenarios (adding N,O,P,Q,R)
      pnpm test:judge     # unchanged, still green
      pnpm test:runner    # green with optional direct lane
  - Commit A1..A9 each as a separate message.

────────────────────────────────────────────────────────────────────────────
COST + TIMING
────────────────────────────────────────────────────────────────────────────

- Haiku canonicalization: ~$0.005 per catalog paste. ~10 providers × once
  per user setup ≈ $0.05 total for a new user's onboarding.
- No per-session cost beyond the shipped judge.
- Exit criterion run (§16 of SPEC): ~$0.40 total (destination + judge).

────────────────────────────────────────────────────────────────────────────
EXIT CRITERION
────────────────────────────────────────────────────────────────────────────

Signals:
  - pnpm test:runner green with the direct-lane addition
  - pnpm test:tui green with 5 new scenarios (N/O/P/Q/R)
  - npx tsc --noEmit exit 0
  - Manual walk: `pnpm dev` on job-search-automation → ApiKeys screen shows
    all 11 rows with correct groupings → paste MOONSHOT_API_KEY → validates
    green → refresh catalog succeeds → advance to PickModels → Kimi K3
    shows with `[3 routes]` badge → PickDestinations shows both OR routes
    and direct:moonshot-intl + direct:nebius rows → space-toggle 4 lanes →
    Confirm → LiveProgress runs all 4 lanes → HTML report renders with
    OR + DIR badges in the lane table.

Once A9 lands, ping Rupul to review + kick off the tweet demo run.

────────────────────────────────────────────────────────────────────────────
QUESTIONS OR AMBIGUITY
────────────────────────────────────────────────────────────────────────────

If the SPEC is ambiguous, prefer the interpretation that:
  1. Never blocks a user with only OR configured (that's today's happy path).
  2. Keeps the ApiKeys row a stable identity (paste → validate → save → update
     status in place, never mid-render reorderings).
  3. Fails soft on catalog / pricing gaps — show `—`, don't crash.
  4. Fails hard on missing API keys at run time — clear error naming the
     screen to fix it on.

For anything unclear beyond that, ask before writing code.

Now: read the SPEC (`c1-multirouter-29july-SPEC.md`), read the shipped
KeySetup + PickModels + PickDestinations + lane.ts + store.ts for context,
then start on A1.
