# canaryone — SPEC: frontier direct providers (DeepSeek pricing, OpenAI, Anthropic, xAI, Google)

**Status:** proposed 2026-07-31. Owner: **Rupul** (runner / proxy).
**Companion spec:** [`c1-pareto-31july-SPEC.md`](./c1-pareto-31july-SPEC.md) — Pareto chart in the HTML report (ships BEFORE this).
**Reading order:** [`c1-runner-28july-SPEC.md`](./c1-runner-28july-SPEC.md) §7 (proxy) → [`c1-launch-29july-SPEC.md`](./c1-launch-29july-SPEC.md) §12 (DIRECT_PRICING) → this doc.
**Trigger:** Hao Liu's Artificial Analysis reply (2026-07-31) with DeepSeek-V4-Flash-0731 on the frontier. To reply with the same visual grammar against a real developer workload, we need frontier models **direct from their providers** as dots on the chart — the ones a reader expects to see: DeepSeek, OpenAI, Anthropic, and (if compat allows) xAI + Google. See reference chart: `.local/dsflash.jpeg` (companion spec §1).

---

## 1. Purpose

Extend `DIRECT_PROVIDERS` and `DIRECT_PRICING` in [`src/proxy/providers.ts`](../../src/proxy/providers.ts) so canaryone can run against frontier providers **directly** (not via OpenRouter or Vercel AI Gateway). Downstream this puts direct-provider dots on the Pareto chart in [`c1-pareto-31july-SPEC.md`](./c1-pareto-31july-SPEC.md).

Ships **after** the Pareto chart spec — the chart machinery is provider-agnostic and doesn't block on this work. Once this ships, canaryone-demo is re-run with the new direct providers and the chart is regenerated for the Hao Liu reply.

Mirrors the existing 9-provider pattern (Moonshot ×2, Nebius, Fireworks, Together, Groq, DeepSeek, Baseten, Cerebras) in [`src/proxy/providers.ts`](../../src/proxy/providers.ts) lines 116–228.

### 1.1 Scope by priority

| Provider   | Priority | Status at spec-time                                                                 |
|------------|----------|--------------------------------------------------------------------------------------|
| DeepSeek   | P1       | Provider **already in** `DIRECT_PROVIDERS` (line 194). `DIRECT_PRICING['direct:deepseek']` is **empty** (line 275). This spec seeds it. |
| OpenAI     | P1       | Not present. Add.                                                                    |
| Anthropic  | P1       | Not present. Add. Anthropic does **not** expose OpenAI-compat `/chat/completions` — see §3. Decision needed at Milestone 1. |
| xAI        | P3       | Not present. Verify compat first (`https://api.x.ai/v1/chat/completions` is OpenAI-compat per xAI docs). Add if verified. |
| Google Gemini | P3    | Not present. Gemini has a `/v1beta/openai/chat/completions` shim but with quirks. Verify first; **skip if flaky** per kill criteria. |

### 1.2 Kill criteria (hard)

- **Not OpenAI-compat → defer.** No shims, no request-body translation, no OR-routing fallback in this spec. If a provider's `/chat/completions` doesn't accept the same OpenAI-schema request that the other 9 direct providers do, that provider is dropped from this milestone.
- **Hard-to-source pricing → skip that model.** `[assumption]`-tagged pricing is worse than no dot. If we can't verify $/M input + $/M output from the provider's own pricing page, skip that model. It won't appear on the chart.
- **Preflight probe must pass on a real key.** [`src/proxy/preflight.ts`](../../src/proxy/preflight.ts) has to return green with the user's actual key before the provider is considered shipped. A red preflight blocks a merge on that provider row.

## 2. Non-goals

- New chart or report work — see companion spec.
- New TUI screens. Model picker stays as-is: new providers just appear as new rows in [`src/screens/ApiKeys.tsx`](../../src/screens/ApiKeys.tsx), and their catalog surfaces via the existing [`src/scan/provider-catalog.ts`](../../src/scan/provider-catalog.ts) flow.
- Request-body translation. If a provider needs `messages` reshaped or a different auth header format beyond `Authorization: Bearer <key>`, it's out of scope. Defer.
- Streaming / SSE — inherited from the existing 9-provider pattern; no new work.
- Judge changes.

## 3. Compat check — Milestone 1

Before touching the code, produce a documented compat matrix. One markdown table at the top of the spec's implementation PR, sourced from live probes with a real key on each provider:

| Provider   | Endpoint URL                                             | Auth header               | `messages` schema match | Streaming | Verdict |
|------------|----------------------------------------------------------|---------------------------|-------------------------|-----------|---------|
| DeepSeek   | `https://api.deepseek.com/chat/completions`              | `Bearer <key>`            | yes                     | yes       | ✅ ship (already in registry; needs pricing) |
| OpenAI     | `https://api.openai.com/v1/chat/completions`             | `Bearer <key>`            | yes (canonical)         | yes       | ✅ ship |
| Anthropic  | `https://api.anthropic.com/v1/messages` (native) OR `https://api.anthropic.com/v1/chat/completions` (compat, if it exists) | `x-api-key: <key>` + `anthropic-version` | native = **no**; compat = **verify** | ? | ❓ verify at M1 |
| xAI        | `https://api.x.ai/v1/chat/completions`                   | `Bearer <key>`            | yes                     | yes       | ❓ verify at M1 |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `Bearer <key>` | shim; quirks reported   | ?         | ❓ verify at M1 |

**Anthropic caveat.** As of last verification, Anthropic exposes an **OpenAI-compat endpoint** at `/v1/chat/completions` on `api.anthropic.com` (announced 2024/2025). It accepts `Authorization: Bearer <key>` and OpenAI-shape requests. Milestone 1 confirms this is still true against a real key. If it's not, Anthropic drops per kill criteria. **`[assumption]`** — verify before scoping in.

Deliverable of Milestone 1: a `docs/compat-matrix-31july.md` file with real probe results, and a scope adjustment to §1.1 in this spec if verdicts change.

---

## 4. Data model changes

### 4.1 `DIRECT_PROVIDERS` additions

New rows appended to the array in [`src/proxy/providers.ts`](../../src/proxy/providers.ts) after the existing Cerebras entry (line 227). Each row mirrors the 9-provider shape:

```ts
{
  kind: 'direct',
  slug: 'direct:openai',
  displayName: 'OpenAI',
  status: 'shipped',                      // or 'proposed' until M3 green
  primaryEnv: 'OPENAI_API_KEY',
  extraEnvs: [],
  forwardUrl: 'https://api.openai.com/v1/chat/completions',
  validationUrlTemplate: 'https://api.openai.com/v1/models',
  catalogUrlTemplate: 'https://api.openai.com/v1/models',
  catalogNeedsAuth: true,
},
```

Rows to add (assuming Milestone 1 verdicts as sketched in §3):

- `direct:openai` — env `OPENAI_API_KEY`
- `direct:anthropic` — env `ANTHROPIC_API_KEY`, only if compat endpoint verified
- `direct:xai` — env `XAI_API_KEY`, only if compat verified
- `direct:google-gemini` — env `GOOGLE_API_KEY`, only if compat verified

**DeepSeek is already registered** (line 194 of `providers.ts`); no `DIRECT_PROVIDERS` change for DeepSeek — only `DIRECT_PRICING` (§4.2).

### 4.2 `DIRECT_PRICING` seeds

`Record<slug, Record<modelSlug, { input, output }>>`. Numbers are per **million tokens** to match the existing convention (§ providers.ts line 232).

Seed a **curated 2–3 models per provider** — the flagship + a cheap tier + the protagonist for the tweet. The user picks additional models via the existing catalog display in the TUI; missing pricing renders as `—` in the report but does **not** crash the run.

Suggested seed (verify each against live pricing pages at Milestone 2):

```ts
'direct:deepseek': {
  'deepseek/deepseek-v4-flash-0731': { input: ?, output: ? },   // protagonist
  'deepseek/deepseek-v4-pro':        { input: ?, output: ? },
},
'direct:openai': {
  'openai/gpt-5.6-luna':             { input: ?, output: ? },
  'openai/gpt-5-mini':               { input: ?, output: ? },
  'openai/o5':                        { input: ?, output: ? },  // reasoning
},
'direct:anthropic': {
  'anthropic/claude-opus-5':         { input: ?, output: ? },
  'anthropic/claude-sonnet-5':       { input: ?, output: ? },
  'anthropic/claude-haiku-5':        { input: ?, output: ? },
},
'direct:xai': {
  'x-ai/grok-4-fast':                { input: ?, output: ? },
  'x-ai/grok-4':                     { input: ?, output: ? },
},
'direct:google-gemini': {
  'google/gemini-3.1-pro':           { input: ?, output: ? },
  'google/gemini-3.6-flash':         { input: ?, output: ? },
},
```

**Model slugs** follow OR-canonical form (`vendor/model-slug`, lowercased with dashes) so [`src/scan/provider-catalog.ts`](../../src/scan/provider-catalog.ts) can normalize direct-provider catalog responses to the same key space as the OpenRouter catalog. See §5 for the canonicalization rules.

Missing pricing (e.g. Milestone 2 can't confirm a number) → **leave that model out of `DIRECT_PRICING`**. The runner's `computeCost` returns 0 → the report renders `—` → the Pareto chart excludes the Destination (per companion spec §4.1). This is the intended behavior.

### 4.3 Model slug canonicalization

Direct providers' `/v1/models` endpoints return provider-native model IDs (e.g. OpenAI returns `gpt-5.6-luna`, DeepSeek returns `deepseek-v4-flash-0731`). [`src/scan/provider-catalog.ts`](../../src/scan/provider-catalog.ts) must map these to OR-canonical slugs (`openai/gpt-5.6-luna`, `deepseek/deepseek-v4-flash-0731`).

Add a canonicalizer per new provider following the existing pattern (Moonshot, DeepSeek, Baseten, etc. already have this). Concretely:

- `direct:openai`: prefix `openai/` if not present.
- `direct:anthropic`: prefix `anthropic/` if not present.
- `direct:xai`: prefix `x-ai/` if not present (matches OR's namespace).
- `direct:google-gemini`: prefix `google/` if not present; strip any `models/` prefix Google's list endpoint returns.
- `direct:deepseek`: already canonicalized; verify unchanged.

Add unit tests in [`tests/provider-catalog.test.mjs`](../../tests/provider-catalog.test.mjs) with fixture responses from each provider's `/v1/models`.

### 4.4 Preflight probe extension

[`src/proxy/preflight.ts`](../../src/proxy/preflight.ts) already validates 9 providers. Extend it so each new provider gets a probe:
- Fetch `validationUrlTemplate` with the resolved API key.
- Assert 2xx status.
- Assert response body is JSON with a `data: []` array (or the provider's native list shape — canonicalize in preflight).
- Log the model count.

**Preflight must be green on a real key before the provider is marked `status: 'shipped'`** in `DIRECT_PROVIDERS`. Until then it stays `status: 'proposed'`, which the UI already handles (hides it from lane selection).

---

## 5. TUI changes — ApiKeys screen

[`src/screens/ApiKeys.tsx`](../../src/screens/ApiKeys.tsx) currently renders one row per provider (9 direct + 4 routers = 13 rows).

**Per the user (2026-07-31):** the new providers are just new rows in this screen. **No new picker screen.** No expanded UI. Their catalog surfaces via the same mechanism as the existing 9 direct providers.

Concrete changes to `ApiKeys.tsx`:
1. Add rows for each new provider that survives Milestone 1. Follow the existing row shape (label, env var, key entry field, catalog fetch button, preflight indicator).
2. Verify existing screens auto-pick up new providers via `listAllProviders()` (line 281 of providers.ts) — if the screen enumerates from that function, no per-row hard-coding is needed. Confirm at Milestone 3.
3. If any row hard-codes a specific provider slug, extend the switch.

No `PickModels.tsx` / `PickRoutes.tsx` / `PickDestinations.tsx` change expected — they iterate the same registry. Verify at Milestone 3 with a real run.

---

## 6. Logo assets

Add SVG symbols to [`src/report/assets/logos/`](../../src/report/assets/logos/) for the new providers, following the existing naming pattern (`<Provider>_Symbol.svg` or `<slug>-icon.svg`):

- `openai-symbol.svg`
- `anthropic-symbol.svg`
- `deepseek-symbol.svg` (DeepSeek is already in `DIRECT_PROVIDERS` but has no logo asset yet)
- `xai-symbol.svg` (only if xAI ships)
- `google-gemini-symbol.svg` (only if Google ships)

Prefer trademark-owner-supplied SVGs from their brand pages (openai.com/brand, anthropic.com/legal/brand, etc.). Do not hand-trace or synthesize.

Each logo is used by:
- The Pareto chart tooltip (companion spec §5.5).
- The existing tweet-card renderer if the winning Destination is one of these providers.
- The leaderboard section.

---

## 7. Files to touch (verified against repo state 2026-07-31)

**Existing files (edit):**
- [`src/proxy/providers.ts`](../../src/proxy/providers.ts) — extend `DIRECT_PROVIDERS`, extend `DIRECT_PRICING`. New rows go after Cerebras.
- [`src/proxy/preflight.ts`](../../src/proxy/preflight.ts) — extend probe list.
- [`src/scan/provider-catalog.ts`](../../src/scan/provider-catalog.ts) — add canonicalizers per new provider.
- [`src/screens/ApiKeys.tsx`](../../src/screens/ApiKeys.tsx) — new rows if enumeration doesn't auto-cover.
- [`tests/providers.test.mjs`](../../tests/providers.test.mjs) — extend fixtures for new providers.
- [`tests/provider-catalog.test.mjs`](../../tests/provider-catalog.test.mjs) — extend fixtures for new canonicalizers.

**New files:**
- [`src/report/assets/logos/openai-symbol.svg`](../../src/report/assets/logos/openai-symbol.svg)
- [`src/report/assets/logos/anthropic-symbol.svg`](../../src/report/assets/logos/anthropic-symbol.svg)
- [`src/report/assets/logos/deepseek-symbol.svg`](../../src/report/assets/logos/deepseek-symbol.svg)
- [`src/report/assets/logos/xai-symbol.svg`](../../src/report/assets/logos/xai-symbol.svg) — conditional
- [`src/report/assets/logos/google-gemini-symbol.svg`](../../src/report/assets/logos/google-gemini-symbol.svg) — conditional
- [`docs/compat-matrix-31july.md`](../compat-matrix-31july.md) — Milestone 1 output.

**Do NOT touch:**
- Locked nomenclature (Model / Router / Provider / Variant / Destination).
- Tweet card ([`src/report/sections/tweet-card.ts`](../../src/report/sections/tweet-card.ts)) — shipped.
- Judge scoring — shipped and off-limits.
- `~/.c1/.env` loading path — proven.
- Branch protection: `main` is protected against force-push and delete. Normal commits only.

---

## 8. Milestones (each = one commit on branch)

1. **Compat matrix.** Manual probes with real keys against each provider's `/v1/chat/completions` and `/v1/models`. Produce `docs/compat-matrix-31july.md`. Adjust §1.1 scope if verdicts flip.
2. **Seed pricing + register DeepSeek pricing.** DeepSeek is already registered — seed `DIRECT_PRICING['direct:deepseek']` for V4-Flash-0731 and V4-Pro. Add new entries in `DIRECT_PRICING` for OpenAI + Anthropic (P1 providers). Verify prices against provider pricing pages. Update `tests/providers.test.mjs` fixtures.
3. **Register OpenAI + Anthropic in `DIRECT_PROVIDERS`.** Add rows. Extend `provider-catalog.ts` canonicalizers. Extend `preflight.ts` probes. Verify green preflight on real keys.
4. **Extend ApiKeys screen if needed.** Confirm new providers appear as rows without hardcoded changes. Add rows only if the screen doesn't auto-enumerate.
5. **Register xAI direct (conditional on M1 verdict).** Add row + pricing + canonicalizer + preflight. If M1 said skip, close this milestone with a `docs/compat-matrix-31july.md` note.
6. **Register Google Gemini direct (conditional on M1 verdict).** Same as above.
7. **Add logo SVGs.** From provider brand pages. Wire into tweet-card + Pareto tooltip renderers.
8. **End-to-end demo run.** Regenerate canaryone-demo with 5+ direct providers, 10 repeats per lane, all Pareto-eligible Destinations. Target 8–12 dots on the chart, at least one surprise winner on the frontier for the specific workload. Ship the reply.

---

## 9. Kill criteria (reminder)

- **Not OpenAI-compat → defer that provider.** No shim.
- **Pricing unverifiable for a model → skip that model.** Don't guess.
- **Preflight probe red on a real key → block ship of that provider.**
- **Trademark issue with a logo asset → ship without the logo, use neutral fill.** Don't hand-trace.

---

## 10. Open questions (spec-time)

1. **Anthropic OpenAI-compat endpoint.** [assumption] It exists and accepts `Authorization: Bearer <key>`. Confirm at M1 with a real key. If it doesn't, Anthropic is deferred (this spec **will not** add a native `/v1/messages` translator).
2. **Reasoning-model pricing.** OpenAI's o5-family and similar reasoning models have separate "reasoning tokens" pricing. Do we model those as (a) extra output tokens (simplest, slightly wrong), (b) a separate accounting line, or (c) roll them into `output` for M2 and refine later? Recommend (a) for M2, revisit if the Pareto chart shows visibly-wrong dots.
3. **Google Gemini's model-slug quirks.** `models/gemini-3.1-pro-preview` vs `gemini-3.1-pro` vs canonical `google/gemini-3.1-pro`. Canonicalizer rules in §4.3 need real-response verification at M6.
4. **Rate-limit handling on direct providers.** The existing 9-provider pattern silently retries via [reference_opencode_operational memory]. Direct providers may have different 429 semantics (OpenAI has strict per-org limits, Anthropic has RPM/RPD tiers). At M8, monitor `opencode.log` for silent retries; if they distort $/pass, escalate.
5. **DeepSeek off-peak pricing.** DeepSeek documents discounted off-peak rates (~50% off). Do we model this in `DIRECT_PRICING`? [assumption] No for M2 — record standard prices. Note in the report footer if this becomes material.
6. **Environment variable naming collision.** `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are conventional names that a user may already have set for other tools. Confirm the ApiKeys screen's env-var loading path (`~/.c1/.env` per memory) doesn't accidentally leak keys from process env to the direct-provider slug. Verify at M3.

---

## 11. Verification (before shipping M8)

- All Milestone 1–7 changes on branch, tests green.
- `c1 doctor` or equivalent (whatever the current preflight surface is) reports green for every new provider row against a user's real keys.
- Run canaryone-demo end-to-end:
  - 5+ direct providers active.
  - 10 repeats per lane.
  - Every lane completes; no silent retries in `opencode.log`.
  - `DIRECT_PRICING` covers every model used (no `—` in the leaderboard for shipped models).
- Regenerate the HTML report (companion spec §12 verification).
  - 8–12 dots on the Pareto chart.
  - Frontier line makes sense.
  - At least one direct-provider dot appears on the frontier — that's the tweet-worthy moment.
- Screenshot the Pareto chart via the export button. Confirm it renders correctly on X's card preview.

Ship the reply to Hao Liu when the screenshot is ready.
