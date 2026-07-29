# canaryone launch — SPEC 1 (runner: multi-router + judge)

**Status:** proposed 2026-07-29. Scope-driven by the OpenRouter announcement ("prove the best model for your project") landing today. Purpose: ship canaryone with a defensible edge — cross-router benchmarking (OR + direct-provider APIs) — before OR's tool launches.

**Parent SPEC:** [`c1-runner-28july-SPEC.md`](./c1-runner-28july-SPEC.md) — Part B is shipped as of `main @ f760907` (D2).
**Companion spec:** [`c1-report-29july-SPEC.md`](./c1-report-29july-SPEC.md) — the HTML report, owned by Bhaskar.

---

## 1. Purpose

Extend the D2 runner along two axes:

- **Multi-router:** the lane proxy currently forwards every request to OpenRouter. Extend it so lanes can point at direct provider APIs (Moonshot, Nebius, Fireworks, Together, Groq, DeepSeek, Cerebras). All are OpenAI-compat, so no new inbound-shape work.
- **Judge:** port the `canaryone-cloud` haiku-r5 judge with local-specific adaptations. Add a `trajectory_quality` dimension + a git-diff-of-worktree signal to catch degenerate passes (narration-without-grounding).

Together these ship the tweet narrative: *"canaryone tests any model across OR routes AND direct providers OR won't route to."*

## 2. Non-goals

- Anthropic native inbound + translator (still deferred; not needed for OpenAI-compat directs)
- Streaming / tool round-trip (D5)
- SessionInspector TUI screen (deferred — HTML report replaces the immediate need)
- RunBrowser TUI screen (deferred)
- `c1 run --continue` (D8)
- Direct-provider Bedrock/Vertex/Azure destinations (v0.2+)

## 3. Invariants (unchanged from parent SPEC §1)

1. canaryone never writes to a file inside the target repo except `<targetDir>/.c1/`.
2. Env-var-swap capture only. No MITM.
3. Zero-default pickers stay zero-default.
4. `--start <screen>` demo paths keep working.

---

# Part A — Multi-router forwarding

## 4. Router + provider registry

canaryone's destination slug is `<router>:<provider>[/<variant>]`. Four routers ship in this SPEC:

- **`openrouter:*`** — already shipped in D2; unchanged.
- **`vercel:*`** — Vercel AI Gateway. Single OpenAI-compat endpoint, gateway routes internally.
- **`cloudflare:*`** — Cloudflare AI Gateway. Requires per-user `account_id` + `gateway_id` on top of API token — **stretch**; ship the plumbing but grey out in TUI until fully configured.
- **`direct:*`** — first-party provider APIs. The core differentiator vs OR's tool.

### 4.1 Router registry

| slug prefix | displayName | forwardUrl template | authEnv | requires |
|---|---|---|---|---|
| `openrouter:` | OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` | key |
| `vercel:` | Vercel AI Gateway | `https://gateway.ai.vercel.app/v1/chat/completions` | `VERCEL_AI_GATEWAY_TOKEN` | key |
| `cloudflare:` | Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{CF_GATEWAY_ID}/openai/chat/completions` | `CF_AI_GATEWAY_TOKEN` | key + `CF_ACCOUNT_ID` + `CF_GATEWAY_ID` |

### 4.2 Direct-provider registry

| slug | displayName | forwardUrl | apiKeyEnvVar |
|---|---|---|---|
| `direct:moonshot-intl` | Moonshot AI (intl) | `https://api.moonshot.ai/v1/chat/completions` | `MOONSHOT_API_KEY` |
| `direct:moonshot-cn` | Moonshot AI (cn) | `https://api.moonshot.cn/v1/chat/completions` | `MOONSHOT_API_KEY` |
| `direct:nebius` | Nebius | `https://api.studio.nebius.ai/v1/chat/completions` | `NEBIUS_API_KEY` |
| `direct:fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1/chat/completions` | `FIREWORKS_API_KEY` |
| `direct:together` | Together AI | `https://api.together.xyz/v1/chat/completions` | `TOGETHER_API_KEY` |
| `direct:groq` | Groq | `https://api.groq.com/openai/v1/chat/completions` | `GROQ_API_KEY` |
| `direct:deepseek` | DeepSeek | `https://api.deepseek.com/chat/completions` | `DEEPSEEK_API_KEY` |
| `direct:cerebras` | Cerebras | `https://api.cerebras.ai/v1/chat/completions` | `CEREBRAS_API_KEY` |

**Model catalog per direct provider:**

- Each direct provider serves a subset of models. We don't try to enumerate exhaustively — instead:
  - When user selects a model on `PickModels`, we filter the direct destinations shown on `PickDestinations` by whether the provider is *known to serve* that model.
  - Shipping heuristic: a small hard-coded map `KNOWN_MODEL_HOSTS: Record<modelSlug, providerSlug[]>` for the top ~10 models we expect users to compare. Everything else falls back to "OR only" for now.
  - Example entry: `'moonshotai/kimi-k3': ['direct:moonshot-intl', 'direct:moonshot-cn', 'direct:nebius', 'direct:fireworks', 'direct:together']`
- The model slug sent in the request body to the direct provider may differ from the OR slug. Provider registry entry gains a per-model slug remap:
  - `remap: Record<orModelSlug, directModelSlug>` — e.g. Moonshot direct's model name for K3 is `kimi-k3-preview` not `moonshotai/kimi-k3`.

## 5. Files to create / modify

- **`src/proxy/providers.ts` (new)** — the registry above, plus:
  - `getProvider(slug)` → registry entry or null
  - `remapModelForProvider(providerSlug, orModelSlug)` → provider-specific slug
  - `getApiKey(providerSlug)` → reads from `process.env[apiKeyEnvVar]` or `~/.c1/.env`
  - `knownHostsForModel(modelSlug)` → provider slugs

- **`src/data/schema.ts`** — extend `LaneSpec` (already in `orchestrator.ts`) via a new field:
  ```ts
  export interface LaneSpec {
    modelSlug: string;
    destinationSlug: string;    // e.g. "direct:moonshot-intl" or "openrouter:baseten/fp4"
    router: 'openrouter' | 'direct-<provider>';
    providerTag: string | null;
    endpoint: OrEndpoint | null;
    fallbackModelPrice: { input: number; output: number } | null;
    // NEW: for direct providers
    forwardUrl: string;         // resolved from providers registry
    apiKey: string;             // resolved from ~/.c1/.env
    modelSlugForForward: string; // may differ from modelSlug (per-provider remap)
  }
  ```

- **`src/proxy/lane.ts`** — currently forwards to hard-coded `OR_URL`. Change:
  - Use `cfg.forwardUrl` instead of hard-coded OR URL
  - Use `cfg.apiKey` in the `Authorization` header (was `cfg.orKey`)
  - Send `body.model = cfg.modelSlugForForward` (may differ from lane's canonical modelSlug)
  - Skip the `provider.order` rewrite when router isn't `openrouter` — direct providers don't understand OR's routing metadata
  - Cost math already falls back to `fallbackModelPrice` when endpoint is null — that covers direct providers too. Ideally direct providers' pricing gets hydrated too (see §7).

- **`src/state/store.ts`** — in `startRun`, when building `LaneSpec[]`:
  - Detect if destinationSlug starts with `direct:`
  - Look up provider in registry
  - Populate `forwardUrl`, `apiKey`, `modelSlugForForward` from registry + remap
  - Fail early with a clear error if `apiKey` missing (user needs to add to `~/.c1/.env`)

- **`src/screens/TokenManager.tsx` (new; replaces KeySetup)** — generic multi-provider token facility. See §5.1 for shape.

- **`src/screens/PickDestinations.tsx`** — extend to also show `vercel:*`, `cloudflare:*`, and `direct:*` destinations for selected models. Grey out destinations whose auth isn't set. Same "zero-default; user must pick" invariant.

### 5.1 TokenManager screen shape

Replaces the old KeySetup (which only prompted for OR key). New behavior:

- Lists every known provider/router in a table
- Shows current status per row: `✓ set (~/.c1/.env)`, `✓ set (env:$VAR)`, `— missing`, or `— partial config` (for Cloudflare when key is set but account_id/gateway_id isn't)
- Live validation for providers with a validation endpoint (OR has `/api/v1/credits`; others get "unverified" status until first real request)
- Keyboard:
  - `↑↓` — navigate rows
  - `p` — paste token for selected row → validate → save to `~/.c1/.env`
  - `d` — delete saved token
  - `enter` — advance (requires at least OR key present — everything else optional)
  - `q` — quit

```
canaryone · Tokens                                              4 of 11 providers configured
──────────────────────────────────────────────────────────────────────────────────────
▸ OpenRouter                ✓ set (~/.c1/.env)           $18.42 credits (validated)
  Vercel AI Gateway         — missing                     [p] paste token
  Cloudflare AI Gateway     — partial config              [p] paste token + [c] account_id + gateway_id
  Moonshot (intl + cn)      ✓ set (~/.c1/.env)
  Nebius                    — missing                     [p] paste token
  Fireworks                 ✓ set (~/.c1/.env)
  Together                  — missing                     [p] paste token
  Groq                      ✓ set (~/.c1/.env)
  DeepSeek                  — missing                     [p] paste token
  Cerebras                  — missing                     [p] paste token

──────────────────────────────────────────────────────────────────────────────────────
[↑↓] navigate  [p] paste  [d] delete  [enter] continue (OR required)  [q] quit
```

Only OR is required to advance — everything else is optional. Missing tokens mean the corresponding destinations grey out in PickDestinations; user can still walk the flow and pick only OR-served destinations.

## 6. Key discovery + validation

- **On boot:** `KeySetup` iterates the provider registry, checks `process.env[apiKeyEnvVar]` and `~/.c1/.env`, marks each provider as `ready`/`missing`. Displays a compact status list.
- **Per-provider validation:** OR has `/api/v1/credits` for validation. Direct providers usually don't. We skip explicit validation and let the first request either succeed or fail. On failure, the step gets `failure_class: 'auth_failed'` and the session's stderr tail carries the provider's error text.

## 7. Direct-provider pricing

For lanes on direct providers, we don't have an OR catalog to hydrate from. Options:

- **v0 (shipping today):** hard-code a small pricing table in `src/proxy/providers.ts` per (provider, model). This is what the tweet demo needs — accurate enough for the money-shot table.
- **v1 (later):** scrape / fetch each provider's pricing endpoint if they have one. Deferred.

The hard-coded table lives next to the registry — user or Bhaskar can update it as new models land. Format:
```ts
export const DIRECT_PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  'direct:moonshot-intl': {
    'moonshotai/kimi-k3': { input: 2.50, output: 12.50 },  // e.g. cheaper than OR's $3/$15
  },
  'direct:nebius': {
    'moonshotai/kimi-k3': { input: 2.80, output: 14.00 },
  },
  // ...
};
```

*(Numbers above are placeholders — I fill them in from each provider's docs during implementation.)*

## 8. Pty scenarios added (Part A)

- **Scenario N:** `--start pickDestinations` with a Kimi K3 model → both OR routes AND direct destinations render → space-toggle a direct destination → advance to Confirm.

---

# Part B — Judge (adapted from canaryone-cloud)

## 9. Source material

Verbatim reuse from `~/Documents/GitHub/canaryone-cloud/scripts/judge_v1.ts`:

- **`summarizeTrajectory` (lines 336–401)** — walks traces in step order, emits `[step N] assistant: ...` and `[step N] tool_result: ...` blocks. The file-re-read-as-diff logic (via `firstReadByPath` + `compactFileDiff`) is the reusable gem — catches "agent read file A, edited it, read it again to verify" without re-emitting 3 KB of source text.
- **`compactFileDiff` (lines 312–334)** — added/removed line diff, size-capped to `MAX_DIFF_CHARS`.
- **`extractFilePath` / `extractFileContentLines` (lines 290–306)** — opencode-style `<path>...</path>` / `<content>...</content>` block parsers.
- **`parseJudgeContent` (lines 449–473)** — structured-output parser with markdown-fence stripping + `{...}` extraction fallback + one retry with stricter reminder.
- **Budget constants (lines 25–29)**:
  - `MAX_CONTENT_CHARS = 3000`
  - `MAX_TOOL_RESULT_CHARS = 4000`
  - `MAX_DIFF_CHARS = 2500`
  - `MAX_TRAJECTORY_CHARS = 40_000`
  - `JUDGE_MAX_TOKENS = 400`

## 10. What we drop (from the hosted judge)

- **OTLP parsing** (`flattenEvents`, lines 173–210). Our input is per-session JSONL records, not OTLP spans.
- **Task-grouping** (`groupIntoTasks`, lines 212–257). Sessions are pre-bounded by our runner; one session = one task-lane-repeat triple.
- **`next_user_prompt` STRONGEST SIGNAL** (prompt lines 421–429). No follow-up prompts in the local model.
- **`not_a_task` outcome**. All sessions ARE tasks by construction.
- **Supabase write path** (`writeTags`, lines 555–672). We write to `classifier_tags` in the local SQLite instead — same schema.

## 11. What we adapt

### 11.1 STRONGEST SIGNAL → `verification_exit_code`

Replace lines 421–429 of `JUDGE_SYSTEM`:

```
STRONGEST SIGNAL — the verification command exit code:

You will see a `verification_exit_code` field:
- 0 → the user's own automated check passed → STRONG evidence of success. Assign confidence 0.85–0.95.
- non-zero → the check failed → STRONG evidence of failure. Assign confidence 0.85–0.95.
- null → no verification command available → rely on content signals only, cap confidence at ~0.85.

The verification is the user's own test — they defined success. Do not override
a passing test with your own guess unless you see explicit trajectory evidence
that undermines it (see TRAJECTORY QUALITY below).
```

### 11.2 New: trajectory score (0-100) with 4 sub-scores

Categorical labels like "grounded / narrated / shallow" don't communicate a rank a stranger can act on. Replaced with a **numeric composite 0-100** built from 4 sub-scores of 25 points each. Half the sub-scores are **computed** from the JSONL (no LLM subjectivity); half are **LLM-judged** with the judge model.

The verdict schema:

```json
{
  "outcome": "success" | "failure" | "uncertain",
  "confidence": 0.0-1.0,
  "reasoning": "<one sentence>",

  "trajectory_score": 0-100,        // sum of the four sub-scores
  "trajectory_confidence": 0.0-1.0, // LLM's confidence in the two judged sub-scores
  "action": 0-25,                   // computed from JSONL — not LLM-judged
  "grounding": 0-25,                // LLM-judged
  "verification": 0-25,             // LLM-judged
  "efficiency": 0-25,               // computed from JSONL — not LLM-judged
  "trajectory_reasoning": "<one sentence>"
}
```

**Sub-score semantics + how each is computed:**

| Sub-score | 0 pts means | 25 pts means | How computed |
|---|---|---|---|
| **Action** | Pure narration; agent never emitted a `tool_call` when task required one | Tool call on every turn where task required it | `min(25, floor(25 × (turns_with_tool_call / max(1, total_turns))))`; single-turn workloads (max 1 turn) score 25 by default (nothing to ground); tasks that touch no files score against the task-type baseline stored in `tasks_meta.uses_llm` |
| **Grounding** | Final answer cites no specific retrieved data; reads like generic training knowledge | Final answer explicitly references retrieved data (log lines, file contents, RAG excerpts) — provably not narrated | LLM-judged; the judge is shown the trajectory + the final response and asked to score 0-25 |
| **Verification** | Agent never re-read its own edits, never ran a check-in-loop | Agent re-verified its work (re-read modified files, invoked test/lint tools mid-loop) | LLM-judged; the file-re-read-diff detector from the ported trajectory summarizer feeds evidence in |
| **Efficiency** | Tool calls redundant/spammy (same tool with same args repeated); wasted budget | Every tool call moved the trajectory forward; no wasted calls | `min(25, floor(25 × (unique_tool_signatures / max(1, total_tool_calls))))` — where "signature" = `(tool_name, canonicalized_args)` |

**Composite = Action + Grounding + Verification + Efficiency.** Range 0-100 by construction.

**How the report renders this:**

The core columns in the lane table:

| Lane | Pass | $/pass | **Traj** | **Weighted $/pass** |
|---|---|---|---|---|
| direct:nebius | 6/6 | $2.75e-6 | **92** | **$2.99e-6** |
| openrouter:moonshotai | 6/6 | $2.83e-5 | 88 | $3.22e-5 |
| direct:groq | 6/6 | $8.00e-7 | 34 ⚠ | $2.35e-6 |

**Weighted $/pass = $/pass ÷ (trajectory_score / 100).** Penalizes lanes that pass the test cheaply but by narration. Above `100` is impossible; the metric always penalizes, never rewards beyond the raw cost.

The Groq row is the punchline: cheapest raw $/pass (< 1 μdollar), but a 34/100 trajectory score means "the test passed for the wrong reasons." Weighted $/pass = ~3 μdollars — worse than Nebius. **This is the metric OR's tool cannot compute** because they don't inspect the transcript.

**Prompt additions to `JUDGE_SYSTEM` for the two LLM-judged sub-scores:**

```
TRAJECTORY SCORE — the trajectory quality assessment.

You will emit a `trajectory_score` from 0-100 built from 4 sub-scores of 25 each.
Two of the sub-scores are computed by the runner from wire data — those will be
filled in for you (you'll see the numbers in the input under `computed_subscores`).
You judge the remaining TWO sub-scores: `grounding` (0-25) and `verification` (0-25).

grounding (0-25):
  Does the FINAL assistant response reference specific data that appeared in the
  trajectory? Not generic knowledge, but specific: file paths from tool_results,
  timestamps from log excerpts, exact identifiers from database rows, direct
  quotes from RAG chunks. If yes, high grounding. If the final response could
  have been written without ever seeing the tool_results (i.e., from training
  knowledge), grounding is low.
  - 0: response reads like a generic training-knowledge answer; no citations
  - 12: some references but could be plausibly hallucinated
  - 25: response directly cites specific retrieved data (file paths, timestamps,
        exact values from tool_results — inclusion is provable)

verification (0-25):
  Did the agent check its own work? Signals:
  - File re-reads after edits (visible in the tool_result stream as
    "[re-read of X — diff vs step Y]")
  - Test/lint tool invocations mid-loop
  - Assertions or checks appearing in the assistant text before the final answer
  0-25 based on presence/absence of these signals.

The runner also passes you `git_diff_summary` (files changed + line counts in
the worktree). Zero-diff + passing test on a task that SHOULD have modified
files is a strong low-verification signal.

Also emit `trajectory_reasoning` — one sentence citing the specific evidence
for your grounding+verification scores.
```

**Confidence:** the `trajectory_confidence` field expresses how sure the judge is about the grounding+verification numbers. Computed sub-scores (action, efficiency) are 100% certain by construction.

### 11.3 New: `git_diff_summary` input (feeds Verification sub-score)

Before calling the judge, the runner captures a compact summary of git changes in the worktree:

```ts
interface GitDiffSummary {
  files_changed: number;
  insertions: number;
  deletions: number;
  paths: string[];             // up to 20 paths, truncated with "(+N more)"
}
```

Computed via `git -C <worktree> diff HEAD --shortstat` and `... --name-only`. If the worktree isn't a git repo (shallow-copy fallback), returns `{ files_changed: 0, insertions: 0, deletions: 0, paths: [] }` and the judge is told the workload isn't file-based.

## 12. Files to create (Part B)

- **`src/judge/prompt-haiku-r5-local.md` (new)** — the full `JUDGE_SYSTEM` prompt with §11.1 + §11.2 adaptations. Checked in for reproducibility.
- **`src/judge/trajectory.ts` (new)** — `summarizeTrajectory` + `compactFileDiff` + budget constants, ported from canaryone-cloud lines 25–401. Reads step data from JSONL byte ranges (via `readRange` from `src/runner/traffic-log.ts`).
- **`src/judge/subscores.ts` (new)** — the computed sub-scores (Action, Efficiency) derived from JSONL. Uses tool-call detection over the request/response bodies. Exports `computeSubScores(sessionId, db, log)` → `{ action: 0-25, efficiency: 0-25 }`.
- **`src/judge/git-diff.ts` (new)** — `captureGitDiff(worktreePath)` → `GitDiffSummary`. Uses `execFile('git', ['diff', 'HEAD', '--shortstat'])` etc.
- **`src/judge/haiku-r5.ts` (new)** — `judgeSession(session, orKey)` → `Verdict`. Assembles input including `computed_subscores`, calls OR with Haiku, parses via `parseJudgeContent`. Combines LLM's grounding+verification with computed action+efficiency into `trajectory_score`.
- **`src/db/sqlite.ts`** — extend `classifier_tags` writes with dimensions: `outcome`, `trajectory_score`, `action_score`, `grounding_score`, `verification_score`, `efficiency_score`, `trajectory_reasoning`. Schema is already generic (dimension/value pairs) — just needs the insert helpers.
- **`src/runner/orchestrator.ts`** — after each session terminates, enqueue a judge job. Judge worker pool (concurrency = 3) processes them in parallel with the next session batch.

## 13. Judge model + cost

- **Model:** `anthropic/claude-haiku-4.5` via `OR_JUDGE_KEY` (fall back to `OPENROUTER_API_KEY`).
- **Cost:** ~$0.005/session estimate. For an 18-session run: ~$0.09 total for the judge pass.
- **Concurrency:** 3 workers. Judge runs in parallel with the runner — a session's judge starts as soon as it terminates.

## 14. Version bump

- Judge prompt version: `2026-07-29-haiku-r5-local`
- Written into the `classifier_tags.classifier_version` column so we can compare against the hosted judge's `2026-07-27-haiku-r5` output if we ever cross-check.

## 15. Testing

- **Unit test:** feed a synthetic session (from a fixture JSONL) through `trajectory.ts` and assert the file-re-read-diff logic collapses the same file's second appearance.
- **Integration test:** extend `tests/runner.test.mjs` (D2's integration harness) to spawn a judge worker after the session completes. Assert `classifier_tags` has both `outcome` and `trajectory_quality` rows for the session, with `outcome = 'success'` and `trajectory_quality = 'n/a'` (single-shot fixture, no trajectory).

## 16. Exit criterion (Part A + Part B combined)

`c1 run` with the following config completes successfully and produces both cost + judge outputs:

- **Target:** demo repo (TBD by SPEC 2 handoff — likely `~/Documents/GitHub/canaryone/demo/`)
- **Model:** `moonshotai/kimi-k3`
- **Lanes (at least 4):**
  1. `openrouter:moonshotai` — Moonshot via OR
  2. `openrouter:baseten/fp4` — Baseten via OR
  3. `direct:moonshot-intl` — Moonshot's direct API (not on OR-only tools)
  4. `direct:nebius` — Nebius direct (not routed by OR)
- **Repeats:** 2
- **Tasks:** 2–3 (from demo repo)
- **Total sessions:** 16–24
- **Expected cost:** ~$0.30 destination + ~$0.10 judge ≈ **$0.40**

Success signals (in addition to D2's):
- `classifier_tags` has `outcome` + `trajectory_quality` rows for every session
- Direct-provider lanes have non-null cost_usd (via hard-coded pricing)
- LiveProgress cells show green ✓ for lanes on both OR and direct APIs
- `.c1/runs/<runId>/report/index.html` exists (SPEC 2 output)

## 17. Provenance

- OR announcement: `@jjacky`, "prove the best model for your project", 2026-07-29
- Session `c1-bld2807-2` (this session)
- Reference judge: `canaryone-cloud/scripts/judge_v1.ts` at classifier_version `2026-07-27-haiku-r5`
- Parent SPEC: `c1-runner-28july-SPEC.md`
