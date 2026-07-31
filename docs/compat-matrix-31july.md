# canaryone — direct-provider OpenAI-compat matrix (2026-07-31)

**Companion to:** [`specs/c1-direct-providers-31july-SPEC.md`](./specs/c1-direct-providers-31july-SPEC.md) §3 (Milestone 1).
**Method:** Live probes with real keys sourced from `~/.c1/.env`. For each provider: one `GET /v1/models`, one non-stream `POST /chat/completions`, one `stream:true` probe. All calls used `max_tokens: 1` or `2`.

## Verdicts

| Provider   | Endpoint                                                                           | Auth                  | `/v1/models` | Non-stream chat | Stream (SSE)      | Verdict |
|------------|------------------------------------------------------------------------------------|-----------------------|--------------|-----------------|-------------------|---------|
| OpenAI     | `https://api.openai.com/v1/chat/completions`                                       | `Authorization: Bearer <key>` | 200 (19 models) | 200, canonical shape | `data: {chunk}` SSE | ✅ ship |
| Anthropic  | `https://api.anthropic.com/v1/chat/completions`                                    | `Authorization: Bearer <key>` | 200 via `/v1/models` (11 models, requires `x-api-key` + `anthropic-version` for catalog) | 200, `object: chat.completion`, `choices[]` shape | `data: {chunk}` SSE | ✅ ship |
| DeepSeek   | `https://api.deepseek.com/chat/completions` *(no `/v1/` on chat; `/v1/models` for catalog)* | `Authorization: Bearer <key>` | 200 (2 models) | 200, adds `reasoning_content` field (harmless extension) | `data: {chunk}` SSE | ✅ ship — pricing needed |
| xAI        | `https://api.x.ai/v1/chat/completions`                                             | `Authorization: Bearer <key>` | 200 (10 models) | 200, adds `reasoning_content` + audio/image token counts | `data: {chunk}` SSE | ✅ ship |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`      | `Authorization: Bearer <key>` | 200 (59 models, IDs prefixed with `models/`) | 200 with a current model; 404 on retired models | `data: {chunk}` SSE + `data: [DONE]` | ✅ ship (with slug canonicalization) |

**All 5 pass compat.** No shims needed. `Authorization: Bearer <key>` works for every provider on both chat and (Anthropic excepted) catalog.

## Key findings

### Anthropic — compat endpoint is real
The spec's `[assumption]` at §3 is confirmed. `https://api.anthropic.com/v1/chat/completions` accepts `Authorization: Bearer <key>` and returns an OpenAI-shape response (`{ object: "chat.completion", choices: [{ index, message: { role, content }, finish_reason }] }`). Initial probe returned HTTP 404 with a `model: claude-3-5-haiku-latest` error — that's a model-not-found on this key, not an endpoint-not-found. Retry with `claude-sonnet-4-6` returned HTTP 200 and a valid completion.

**Catalog auth resolution:** `/v1/models` on `api.anthropic.com` requires the native Anthropic auth (`x-api-key` + `anthropic-version: 2023-06-01`) — Bearer 401s. This is not a request-body translator (spec kill criteria only prohibits `/chat/completions` shape shims), so a per-provider auth-header override is within scope. Landed 2026-07-31: `BaseEntry.catalogAuthKind?: 'anthropic'` field, wired through `fetchModels` and `validateAndSave`. Anthropic catalog now returns 11 models on a real key.

### Gemini — `models/` prefix on catalog
`GET /v1beta/openai/models` returns IDs like `models/gemini-3.6-flash`, not `gemini-3.6-flash`. The canonicalizer at §4.3 already anticipates this (strip `models/`). Confirmed against live response.

Also, Gemini's `/openai/chat/completions` accepts the un-prefixed model ID in the request body (`"model": "gemini-3.6-flash"` works), so the canonicalizer only needs to run on catalog output, not on request routing.

### DeepSeek — chat path has no `/v1`
The chat endpoint is `https://api.deepseek.com/chat/completions` (no `/v1/`), but `/v1/models` uses `/v1/`. Matches the existing `providers.ts` line 199 registration. No change needed.

Response includes non-standard `reasoning_content` alongside `content`. The existing 9-provider pattern already handles unknown response fields (they're passed through). Harmless.

### xAI — reasoning + multimodal token counts
Response `usage` block includes `prompt_tokens_details: { text_tokens, audio_tokens, image_tokens, ... }` and `completion_tokens_details: { reasoning_tokens, text_tokens, ... }`. Standard `prompt_tokens` + `completion_tokens` are present, so cost accounting via `computeCost` works unchanged. If reasoning-heavy models materially distort $/pass on the Pareto chart, revisit per spec §10.2.

Also: xAI reported `prompt_tokens: 193` on a `"hi"` request — implies a large hidden system prompt (Grok persona). Note for M8 — will show up as a fixed input-token overhead on any run.

## Actual model IDs by provider (live catalog dump)

Trimmed to models plausibly worth seeding in `DIRECT_PRICING`. Full catalogs saved to `/tmp/{provider}_models.json` during probe.

**OpenAI** (sample): `gpt-4`, `gpt-4-turbo`, `gpt-4o`, `gpt-4o-mini`, `gpt-4o-2024-08-06`, `gpt-5-chat-latest` — no `gpt-5.6-luna` in this account's catalog. The spec's placeholder slug is aspirational.

**Anthropic** (11 total): `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-5-20251101`, and 3 more. Both `claude-opus-5` and `claude-sonnet-5` are present — spec seed slugs match. `claude-haiku-5` did NOT appear in the account's catalog dump; verify at M2.

**DeepSeek** (2 total): `deepseek-v4-flash`, `deepseek-v4-pro`. **No `-0731` suffix on flash** — spec's placeholder `deepseek-v4-flash-0731` is not the actual ID. Use `deepseek-v4-flash`.

**xAI** (10 total): `grok-4.20-0309-non-reasoning`, `grok-4.20-0309-reasoning`, `grok-4.20-multi-agent-0309`, `grok-4.3`, `grok-4.5`, `grok-build-0.1`, `grok-imagine-image`, `grok-imagine-image-quality`, + 2 more. **No `grok-4-fast`** — the modern equivalents are `grok-4.3` and `grok-4.5`. Multi-agent + reasoning variants exist but likely out of scope for a text-quality Pareto chart.

**Gemini** (59 total, key candidates): `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3-flash-preview`, `gemini-3-pro-preview`, `gemini-3.1-pro-preview`, `gemini-flash-latest`, `gemini-pro-latest`. **`gemini-3.1-pro` (bare, no `-preview`)** does not exist. Use `gemini-3.1-pro-preview` or `gemini-pro-latest`.

## Scope adjustment vs SPEC §1.1

None. All 5 providers survive Milestone 1. Proceed to M2 with all 5.

**Slug corrections propagating to §4.2 pricing seeds:**
- `deepseek/deepseek-v4-flash-0731` → `deepseek/deepseek-v4-flash`
- `openai/gpt-5.6-luna` → drop (not in this account); recommend `openai/gpt-5-chat-latest` or protagonist TBD after user picks
- `openai/o5` → not present; drop or replace with a current reasoning model at M2
- `x-ai/grok-4-fast` → `x-ai/grok-4.3` (fastest current); flagship `x-ai/grok-4.5`
- `google/gemini-3.1-pro` → `google/gemini-3.1-pro-preview` (or `google/gemini-pro-latest`)
- `google/gemini-3.6-flash` → confirmed exists as-is

## Kill criteria status

| Criterion | Status |
|---|---|
| Not OpenAI-compat → defer | ✅ N/A — all 5 pass |
| Unverifiable pricing → skip model | ✅ Cleared — 31 models seeded, 3 OpenAI aliases (gpt-5-chat-latest, gpt-5.1-chat-latest, gpt-5-codex) and Google's `*-latest`/2.0 aliases skipped per kill criteria |
| Red preflight on real key → block ship | ✅ Cleared — real `probeLane()` returned 200 for all 5 (see `scripts/preflight-new-providers.mjs`) |

## Formal preflight results (2026-07-31)

Run via `node --import tsx scripts/preflight-new-providers.mjs`:

```
✅ direct:openai (gpt-4o-mini):        ok 200 1360ms
✅ direct:anthropic (claude-sonnet-4-6): ok 200 1076ms
✅ direct:deepseek (deepseek-v4-flash): ok 200 384ms
✅ direct:xai (grok-4.3):               ok 200 1690ms
✅ direct:google-gemini (gemini-3.6-flash): ok 200 1264ms
```

All 5 flipped to `status: 'shipped'` in `DIRECT_PROVIDERS`.

## Pricing cross-check note

Every hand-verified pricing value matches OpenRouter's `/api/v1/models` catalog entry for the same canonical slug — 100% match on 30+ models across the 5 providers. OR resells at exact provider list price, so OR pricing can serve as a proxy source for future direct-provider additions. Not adopted as the runtime source in this PR (see spec follow-up).

## Probe log (raw)

All probes executed 2026-07-31. Response bodies captured under `/tmp/{provider}_{models,chat,stream}.json`. Total spend well under $0.05.
