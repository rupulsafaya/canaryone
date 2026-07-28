# canaryone runner — iter1.5 + iter2 SPEC

**Status:** proposed 2026-07-28. **De-risked 2026-07-28** — 6 spikes proved every load-bearing translator + multi-turn pattern end-to-end. See `spike/iter2-proxy/README.md`. Two amendments folded in from de-risk: per-turn body capture mandatory (§15.2), per-lane timeout budget (§13.4).
**Scope:** two-part build plan.
- **Part A (iter1.5)** — LLM-driven methodology detection during onboarding. ~2-3 days.
- **Part B (iter2)** — reverse proxy (OpenAI-compat + Anthropic-native + translator) + subprocess spawn + git worktree + append-only wire log + resume + real judge + SQLite. ~2-3 weeks. Depends on Part A shipping first.

**Parent SPEC:** [`c1-local-SPEC-2707-v0.md`](./c1-local-SPEC-2707-v0.md) — §4 architecture, §5 capture layer, §6 codebase scan, §10 comparison mechanics, §11 judge, §12 storage.
**Predecessor SPEC:** [`c1-firstrun-28july-SPEC.md`](./c1-firstrun-28july-SPEC.md) — iter1 shipped (KeySetup → Onboarding scan wizard → Summarize with usesLLM → Pickers → Confirm). Cache: `~/.c1/.env`, `~/.c1/or-catalog.json`, `<repo>/.c1/config.json`, `<repo>/.c1/scan.json`.

---

## 1. Invariants (both parts)

1. **canaryone never writes to a file inside the user's target repo except `<targetDir>/.c1/`.** All benchmark runs happen in ephemeral git worktrees. Source is read-only from canaryone's perspective.
2. **Env-var-swap capture only.** No MITM certs. No source-code mutation. Proxy sees requests only when the user's SDK reads `*_BASE_URL` from env (or a config path that traces back to env).
3. **Zero-default pickers stay zero-default.** iter1 rule: user must actively select tests/models/destinations before Enter advances.
4. **`--start <screen>` demo paths keep working.** All new screens honor `--start` with sensible fixture fallbacks.

## 2. Non-goals (locked for these iterations)

- Auto-fix suggestions for `sdk-hardcoded` cases (v0.1 — for now, block + tell the user what to change).
- Direct-provider destinations (Anthropic-direct, Bedrock, Vertex, Azure) — iter5 per parent SPEC.
- Fan-out or trace-replay comparison — parent SPEC locked task-replay only.
- Cross-run history / trend view — v0.1+.
- Docker-only agents — parent SPEC v0 limitation.
- OR-specific inbound shape (`POST /api/v1/chat/completions` with OR-only extensions) — OR speaks OpenAI-compat, that's enough for iter2.

**In scope (moved back from initial non-goals after real-repo probe):**
- **Anthropic native inbound (`POST /v1/messages`) with translator to OpenAI shape** — required because our exit-criterion repo (`job-search-automation`) uses `@anthropic-ai/sdk` which hits `/v1/messages` natively when `ANTHROPIC_BASE_URL` is swapped. Roughly ~half of real-world Claude agents will hit the same requirement. Skipping this would make iter2's exit-criterion unreachable.

---

# Part A — Methodology detection (iter1.5)

## 3. Purpose

Before iter2's proxy is real, we need to know per repo: **will env-var swap actually intercept this codebase's LLM calls?** If not, the proxy will run, see nothing, and produce meaningless benchmark output. Detecting this at onboarding time saves users from wasting spend + gives us a clean product positioning line: "canaryone works with codebases that use standard SDK patterns."

## 4. Detection taxonomy

Every repo scan resolves to one of four states:

| State | Meaning | Advance? |
|---|---|---|
| `sdk-env` | Known SDK detected; base URL reads from env var (either SDK default or explicit `process.env.*_BASE_URL`). | ✓ silent |
| `sdk-config` | Known SDK detected; base URL is a config value that traces back to `process.env.X` for some `X`. | ✓ silent |
| `sdk-hardcoded` | Known SDK detected; base URL is a hardcoded string literal. Proxy won't intercept. | ✗ **hard block** with actionable file/line + suggestion to swap for `process.env.<SDK>_BASE_URL`. |
| `no-sdk-detected` | Raw `fetch`, `httpx`, `requests`, or an unknown provider wrapper. Interception not guaranteed. | ✗ **hard block** with a "canaryone supports Vercel AI SDK, Anthropic SDK, OpenAI SDK, LangChain, Mastra, LiteLLM, LlamaIndex" hint. |

**Positioning intentional:** canaryone is for teams whose agents use standard SDK patterns. Hard-blocking the two bad states is the enforcement side of that positioning.

## 5. SDK seed list (iter1.5)

Detection recognizes these SDKs from imports + call patterns:

- `openai` (JS/Python) — honors `OPENAI_BASE_URL` env
- `@anthropic-ai/sdk` (JS/Python) — honors `ANTHROPIC_BASE_URL` env
- `openrouter*` / OpenAI-compat clients pointed at OpenRouter — honors `OPENROUTER_BASE_URL` or configured `baseURL`
- `ai` (Vercel AI SDK) — via `createOpenAI({baseURL:...})`, `createAnthropic({baseURL:...})`, etc.
- `langchain` / `@langchain/*` (JS/Python) — `ChatOpenAI({configuration: {baseURL:...}})`, `ChatAnthropic`
- `@mastra/*` — layered on Vercel AI SDK; inherits interceptability
- `litellm` (Python) — honors OpenAI env vars
- `llamaindex` / `llama-index` (JS/Python) — provider factories

Any other SDK or raw HTTP → `no-sdk-detected`.

## 6. Detection pipeline

### 6.1 Bundle assembly

For each configured test file:

1. Parse imports (regex; language-aware for TS/JS/Python).
2. Resolve to disk paths — respect `tsconfig.json:paths`, `package.json:main`, node_modules resolution, Python package layout.
3. Walk transitively. **No cap for iter1.5** — grab everything the test would run (biggest-file-first, but include all resolved paths; optimize the cap later if repos are giant).
4. Skip `node_modules/` files EXCEPT for the top-level entry of recognized SDKs (so Haiku sees which SDK is imported without wading through vendor code).
5. Deduplicate across all tests → one repo-wide bundle.

### 6.2 Haiku call

Single call per repo (not per file):

- **Model:** `anthropic/claude-haiku-4.5` via `OPENROUTER_API_KEY`.
- **System:** compact instructions + JSON schema (see §6.3).
- **User:** the assembled bundle labeled by relative path.
- **Structured output:** JSON with schema below.

### 6.3 Output schema

```ts
interface MethodologyReport {
  state: 'sdk-env' | 'sdk-config' | 'sdk-hardcoded' | 'no-sdk-detected';
  primarySdk: string | null;        // e.g. "openai", "anthropic-sdk", "ai" (Vercel), "langchain", "mastra", "litellm", "llamaindex", null
  otherSdks: string[];              // additional SDKs found
  evidence: string;                 // one paragraph, <= 400 chars, explaining what Haiku observed
  hardcodedSites?: Array<{          // populated when state is sdk-hardcoded
    file: string;                   // relative path
    line: number | null;
    literal: string;                // the offending URL literal, truncated
    suggestedEnvVar: string;        // e.g. "OPENAI_BASE_URL"
  }>;
  followedFiles: string[];          // paths Haiku walked (relative)
  scannedAt: string;                // ISO
  model: string;                    // "anthropic/claude-haiku-4.5"
}
```

### 6.4 Persistence

Written to `<repo>/.c1/config.json` under new key `methodology`. Invalidated when any followedFile mtime > `scannedAt`. Manual re-scan via `--rescan-methodology` (new CLI flag) or `--rescan` (existing; extends to methodology too).

## 7. Screen wiring

### 7.1 Where it runs

- **New screen `MethodologyCheck`** between `SummarizeTasks` and `PickTasks` (only rendered when needed).
- Skipped entirely when cached methodology exists and no followedFile mtimes have changed since scan.
- Shown as a progress screen with a single spinner: `Analyzing how this codebase calls LLMs…` (~2-5s typical for Haiku).

### 7.2 States rendered

- **`sdk-env` / `sdk-config`** → screen briefly shows `✓ Detected {primarySdk} — proxy will intercept via {envVar}`, then auto-advances after 800ms (readable but non-blocking).
- **`sdk-hardcoded`** → renders the hardcoded sites list with file/line, the suggested env-var swap, `[q] quit`. Enter is disabled. User must fix the code and re-run.
- **`no-sdk-detected`** → renders the SDK seed list, evidence Haiku found, `[q] quit`. Enter disabled.

### 7.3 Advance path

Only `sdk-env` and `sdk-config` reach `PickTasks`. Everything else blocks. Consistent with the "zero-default; user must act" rule from iter1.

## 8. Files to create/modify (Part A)

- `src/scan/methodology.ts` **new** — import parser (TS/JS/Python), transitive resolver, bundle assembler, Haiku call, structured output validation.
- `src/data/schema.ts` — add `MethodologyReportSchema`, thread into `ConfigSchema` as optional `methodology` field.
- `src/state/store.ts` — new state: `methodology: MethodologyReport | null`, `methodologyStatus: 'idle'|'loading'|'ready'|'blocked'`. New action `loadMethodology()`.
- `src/screens/MethodologyCheck.tsx` **new** — the screen described in §7.
- `src/App.tsx` + `src/cli.tsx` + `src/state/store.ts` — new screen enum `methodologyCheck`, `--start methodologyCheck` support.
- `src/screens/SummarizeTasks.tsx` — accept transition targets: `MethodologyCheck` on next.
- `src/cli.tsx` — `--rescan-methodology` flag.

## 9. Testing (Part A)

- **Target: `job-search-automation`** — should resolve to `sdk-env` (uses Anthropic SDK with default base URL).
- **Target: `canaryone-cloud`** — should resolve to `sdk-env` (Vercel AI SDK / Anthropic SDK).
- **Synthetic negative test** — a tiny fixture repo under `tests/fixtures/hardcoded-repo/` with a literal `baseURL: "https://api.groq.com/openai/v1"` — should resolve to `sdk-hardcoded` with the file/line reported.
- **Synthetic negative test** — a tiny fixture repo under `tests/fixtures/raw-fetch-repo/` using `fetch("https://...")` — should resolve to `no-sdk-detected`.

Pty scenario `K` covers all four, extending the harness.

## 10. Exit criterion (Part A)

`c1` boot in `job-search-automation` → after SummarizeTasks completes → MethodologyCheck renders → within 5s shows `✓ Detected @anthropic-ai/sdk — proxy will intercept via ANTHROPIC_BASE_URL` → auto-advances to PickTasks. tsc clean. 11/11 pty scenarios pass.

---

# Part B — Reverse proxy + real runner (iter2)

Requires Part A shipped first. Consumes `methodology.state === 'sdk-env' | 'sdk-config'` as a hard precondition for `c1 run`.

## 11. Runtime overview

```
c1 CLI (main process)
  │
  ├─ Proxy manager
  │    ├─ port 11434 = router / discovery (fixed)
  │    └─ ports 11435..N = per-lane proxies (ephemeral)
  │
  ├─ Runner (per RUN invocation)
  │    ├─ For each (task, lane, repeat) triple:
  │    │    ├─ create git worktree
  │    │    ├─ symlink deps-cache/node_modules
  │    │    ├─ allocate lane port
  │    │    ├─ spawn subprocess (runner.cmd), env includes OPENAI_BASE_URL=http://localhost:<port>
  │    │    ├─ collect exit code + verification output
  │    │    ├─ tear down worktree
  │    │    └─ release port
  │
  └─ Judge worker pool
       ├─ Haiku 4.5 haiku-r5 prompt
       └─ Writes classifier_tags rows
```

## 12. Proxy design

### 12.1 Port strategy

- **Port `11434`** — fixed, reserved. **Not** used for request forwarding in iter2. Reserved because SPEC §5 said so and it's the discoverable "canaryone is here" marker. Returns a 200 with a JSON `{"canaryone": "vX.Y.Z"}` on `GET /` for diagnostics.
- **Ports 11435..∞** — ephemeral, one per lane subprocess. Allocated via `net.createServer().listen(0)` (OS picks). Released on subprocess exit.

Fallback: if 11434 is in use (Ollama running locally), skip it silently — the router role is nice-to-have, not load-bearing. Ephemeral ports work regardless.

### 12.2 Inbound shapes (two)

**Both OpenAI-compat AND Anthropic native.** The Anthropic SDK, when its base URL is overridden via `ANTHROPIC_BASE_URL`, sends its native shape (`POST /v1/messages`) — it does NOT auto-translate to OpenAI-compat. Since real-repo probe confirmed our exit-criterion target uses this path, iter2 must serve both.

Endpoints served per lane port:

| Path | Method | Purpose |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI-compat chat completion. Streaming (SSE) and non-streaming. Forwarded unchanged (after model + provider.order rewrite) to OpenRouter. |
| `POST /v1/messages` | Anthropic native messages API. Translated to OpenAI-compat before forwarding to OpenRouter. Response translated back to Anthropic shape on the way out. See §12.3. |
| `GET /v1/models` | Returns `[{id: <laneModel>}]`. Some SDKs probe this on init. |
| `GET /` | Diagnostics `{lane: {model, destination, taskId, repeatIx}, port}`. |
| `*` | 404 with a helpful message + pointer to supported paths in the response body. |

### 12.3 Anthropic ↔ OpenAI translator

**Inbound direction (Anthropic → OpenAI, before forwarding to OR):**

| Anthropic field | OpenAI field | Notes |
|---|---|---|
| `model` | `model` | Overwritten to lane's model anyway |
| `system` (string or blocks) | `messages[0]` with `role: "system"` | Multiple system blocks concatenated with `\n\n` |
| `messages[]` | `messages[]` | Role/content near-1:1. See content-block handling below |
| `messages[].content` (string) | `messages[].content` (string) | Passthrough |
| `messages[].content[]` (blocks) | `messages[].content[]` (parts) | Anthropic block types → OpenAI parts (§12.3.a) |
| `max_tokens` | `max_tokens` | Passthrough |
| `temperature`, `top_p`, `top_k` | same names | `top_k` is not in OpenAI standard — dropped with a warning row in `steps.translation_notes` |
| `stop_sequences` | `stop` | Rename |
| `tools[]` | `tools[]` | Anthropic `input_schema` → OpenAI `function.parameters` |
| `tool_choice` | `tool_choice` | `auto` / `any` / `tool` → OpenAI equivalents |
| `stream` | `stream` | SSE handled below |
| `metadata` | dropped | Not in OpenAI standard; recorded in `translation_notes` |

**§12.3.a — content block mapping (inbound):**

| Anthropic block type | OpenAI part | Notes |
|---|---|---|
| `text` | `{type: "text", text: ...}` | 1:1 |
| `image` (base64 or URL) | `{type: "image_url", image_url: {url: ...}}` | base64 → `data:...` URL |
| `tool_use` (assistant) | `{type: "tool_calls", tool_calls: [{id, function: {name, arguments}}]}` | assistant messages only |
| `tool_result` (user) | `{role: "tool", tool_call_id, content}` | Anthropic bundles this in a user message; OpenAI needs a separate `tool` role message. Translator splits user messages containing tool_result blocks into multiple OpenAI messages |
| `document` (PDFs, etc.) | dropped for iter2 | Recorded in `translation_notes` |

**Outbound direction (OpenAI response → Anthropic, before returning to caller):**

| OpenAI field | Anthropic field | Notes |
|---|---|---|
| `choices[0].message.content` | `content: [{type: "text", text: ...}]` | Wrap in block |
| `choices[0].message.tool_calls[]` | `content: [{type: "tool_use", id, name, input}, ...]` | Merge into content array alongside text |
| `choices[0].finish_reason` | `stop_reason` | `stop` → `end_turn`, `length` → `max_tokens`, `tool_calls` → `tool_use` |
| `usage.prompt_tokens` | `usage.input_tokens` | Rename |
| `usage.completion_tokens` | `usage.output_tokens` | Rename |
| `id`, `model` | passthrough | Keep OR's ids and model returned |

**§12.3.b — SSE translation.**

Anthropic SSE emits typed events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`. OpenAI SSE emits generic `data: {choices: [{delta: {...}}]}` chunks terminated by `data: [DONE]`. The translator holds state per stream (accumulating tool-call argument fragments) and emits Anthropic-typed events as OpenAI deltas arrive. Cost: ~150 lines of streaming state machine. Well-scoped; add ~1-2 days to iter2 estimate.

**§12.3.c — Translation record.**

Every translated request records a compact `translation_notes` field on the `steps` row: any fields dropped, any block types dropped, `stream` mode used. Lets us grep for edge cases in real traffic.

### 12.4 Per-request flow

1. Parse inbound JSON body. Route by path: `/v1/chat/completions` → passthrough after rewrite; `/v1/messages` → translate to OpenAI shape via §12.3, then rewrite.
2. Look up lane config from the port. Rewrite:
   - `body.model = laneConfig.modelSlug` (e.g. `"z-ai/glm-5.2"`)
   - `body.provider = { ...body.provider, order: [laneConfig.destinationTag] }` (e.g. `["baseten/fp8"]`) — **overwrites** any existing `provider.order`.
3. Assign `stepId = uuid()`. Insert a pending row into `steps`.
4. Forward to `https://openrouter.ai/api/v1/chat/completions` with the user's `OPENROUTER_API_KEY` (Bearer). Preserve `Accept: text/event-stream` if set.
5. If streaming: passthrough SSE bytes chunk-by-chunk to the caller, simultaneously buffering + parsing usage from the terminal `[DONE]`-adjacent chunks. Finalize `steps` row after last chunk.
6. If non-streaming: forward buffered response, capture usage from body, finalize row.
7. On 429: exponential backoff up to `--max-retries` (default 3). On terminal failure: log to `steps` with `failure_class`, return the OR error verbatim to the subprocess.
8. Compute cost from step usage × destination pricing (already loaded in `orCatalog.endpointsBySlug`).

### 12.5 What we do NOT do

- No MITM. No cert install.
- No prompt/response mutation beyond `model` and `provider.order`.
- No inter-step fallback within a single request. If OR rejects the lane's destination, the step fails; user sees `failure_class = destination_unavailable`.

## 13. Subprocess spawn + git worktree

### 13.1 Worktree per (task, lane, repeat)

Per parent SPEC §10.

```
<targetDir>/.c1/worktrees/<run_id>/<session_id>/
```

Created via `git worktree add <path> HEAD` (from the target repo). Deleted via `git worktree remove --force <path>` after session ends. **`.c1/` inside the target repo is git-ignored** so the worktree tooling doesn't get confused about it.

### 13.2 Deps cache

Once per `c1 run` invocation, before the first subprocess spawns:

- Detect package manager from lockfile (same logic as scan.deterministic).
- Install into `<configDir>/deps-cache/` if not present or if `package.json.mtime > deps-cache.mtime`.
- Each worktree symlinks its `node_modules` to `<configDir>/deps-cache/node_modules`.

Python: `<configDir>/deps-cache/.venv/` with `pip install -r requirements.txt` (or `uv sync`). Same symlink-into-worktree pattern.

### 13.3 Env var injection

Subprocess spawned with:

```
OPENAI_BASE_URL=http://localhost:<lanePort>/v1
ANTHROPIC_BASE_URL=http://localhost:<lanePort>
OPENROUTER_BASE_URL=http://localhost:<lanePort>/api/v1
C1_RUN_ID=<uuid>
C1_SESSION_ID=<uuid>
C1_LANE=<model@destination>
OPENROUTER_API_KEY=<user's key>   // subprocess needs it for whatever fallback logic exists; proxy rewrites regardless
```

Original env is inherited otherwise.

### 13.4 Timeouts + caps

- **Per-lane timeout budget, not a global cap.** The multi-turn de-risk (`spike/iter2-proxy/`) showed a 6.2× latency spread across three lanes on an identical prompt (25s claude → 157s deepseek). A single global 6-min hard cap would either kill legitimate deepseek runs or waste wall-clock on claude runs while enforcing artificial parity. Instead:
  - **Default per-lane ceiling: `6 min`** (SPEC §10 legacy).
  - **Optional warmup calibration:** first session per lane sets a baseline; subsequent sessions on that lane get `min(6min, baseline × 5)` — bounds runaway agents without penalizing slow providers.
  - **`--session-timeout <lane>=<sec>` CLI override** for known-slow lanes.
- **$0.50 self-reported cost cap** per session — cumulative step cost tracked live; when hit, subprocess is SIGKILLed with `failure_class = cost_cap`.
- **60 step cap** per session — a runaway agent that generates >60 LLM calls is killed with `failure_class = step_cap`.

### 13.5 Cleanup

- SIGINT/SIGTERM handlers on the c1 process: kill all active subprocesses, remove all active worktrees, close proxy sockets.
- On next boot, scan `<configDir>/worktrees/` — any dir older than 24h is garbage-collected (session interrupted, previous cleanup didn't run).

## 14. Judge

Ported from parent SPEC §11 + hosted `scripts/judge_v1.ts`:

- **Model:** `anthropic/claude-haiku-4.5` via `OR_JUDGE_KEY` if set, else `OPENROUTER_API_KEY`.
- **Prompt:** the `2026-07-27-haiku-r5` variant (finish_reason signal + wider tool_result window + file-re-read diff view). To be committed into the repo at `src/judge/prompt-haiku-r5.md` for reproducibility.
- **Input per session:** initial prompt, full trajectory (all step request/response pairs), repo diff (`git diff HEAD` from the worktree), verification exit code + stdout/stderr tail.
- **Output:** `success | failure | uncertain` + `failure_reason` + `confidence` + `dimensions[]` (structured tags per parent SPEC §12 `classifier_tags`).
- **Concurrency:** judge workers run in parallel with the runner. When a session finishes, a judge job is queued.
- **Cost:** ~$0.005/session estimate; real number computed from Haiku's live catalog price.

## 15. Storage (iter2)

Two-layer storage with a clear split of responsibility:

| Layer | Path | Role | Source of truth for |
|---|---|---|---|
| **Wire log (JSONL)** | `<repo>/.c1/runs/<run_id>/traffic.jsonl` | append-only tape, one JSON object per intercepted request/response/chunk/error | The raw wire — what actually happened between subprocess and destination. If SQLite is toast, this rebuilds it. Human-readable-ish. |
| **SQLite index** | `<repo>/.c1/db.sqlite` | queryable, transactional | Aggregate state — "did session X complete?", "what was the judge verdict?", "cost per lane". Everything the TUI queries. |

**Write order (crash safety):**

1. Every wire event is fsync'd to `traffic.jsonl` BEFORE the corresponding SQLite row is committed. If the process dies between the JSONL write and the SQLite commit, `c1 run --continue` will replay the tail of `traffic.jsonl` into SQLite before resuming.
2. Session-terminal events (completion, failure, judge verdict) are committed to SQLite in a single transaction so partial state is impossible from a crash mid-commit.
3. The judge worker reads SQLite for session state, reads `traffic.jsonl` byte range (`steps.traffic_log_offset` → `steps.traffic_log_length`) for full request/response bodies when needed.

### 15.1 SQLite index

- **Location:** `<repo>/.c1/db.sqlite`. Gitignored via `ensureGitignore` (iter1).
- **Driver:** `node:sqlite` (Node 22+). Bump `engines.node` in `package.json` from `>=20` to `>=22`.
- **Schema:** parent SPEC §12, minimal subset for iter2:
  - `runs` — full schema
  - `sessions` — full schema (`sessions.status IN ('queued','running','complete','failed','aborted')`)
  - `steps` — full schema + iter2 additions: `translation_notes JSON NULL`, `inbound_shape TEXT` ('openai' | 'anthropic'), `traffic_log_offset INT` (byte offset into the JSONL for O(1) lookup)
  - `tasks_meta` — full schema
  - `classifier_tags` — full schema
  - Defer indexing/perf work to iter3.
- **Migrations:** `PRAGMA user_version`, one embedded migration file. Ship v1 with iter2.

### 15.2 Wire log — append-only JSONL + human-readable Markdown

Every intercepted request/response pair is written to disk **before** the corresponding SQLite row is committed. If SQLite crashes, the run can be recovered by replaying the log.

**Location:** `<repo>/.c1/runs/<run_id>/`

Per run:

```
<repo>/.c1/runs/<run_id>/
  ├─ meta.json         — run config snapshot: lanes, tasks, repeats, parallelism, started_at
  ├─ traffic.jsonl     — one JSON record per intercepted (request, response) pair (source of truth)
  ├─ traffic.md        — human-readable mirror of traffic.jsonl; regenerable via `c1 runs show <id>`
  ├─ sessions/
  │    └─ <session_id>.md   — per-session narrative: prompt, trajectory, verification output, judge verdict
  └─ report/                 (populated by iter3 report generator)
```

**Load-bearing requirement (post-spike):** per-turn full-body capture is mandatory. A multi-turn agent trial can produce an aggregate `(turns, tool_calls)` pair that looks reasonable but hides a degenerate trajectory (e.g. 11 assistant-text turns with zero tool invocations — the model narrating without grounding). Without full request+response bodies persisted per turn, we cannot judge trajectory quality — only outcome. That defeats the "compare lanes on YOUR workload" promise. See the multi-turn de-risk workflow findings in `spike/iter2-proxy/README.md`.

**`traffic.jsonl` record shape (one JSON object per line, `\n`-terminated):**

```jsonc
{
  "ts": "2026-07-28T13:45:07.212Z",
  "kind": "request" | "response" | "chunk" | "error",
  "run_id":     "01HMV...",
  "session_id": "01HMW...",
  "step_id":    "01HMX...",
  "step_ix":    0,
  "lane": { "model": "z-ai/glm-5.2", "destination": "openrouter:baseten/fp8" },
  "inbound_shape": "anthropic",         // 'openai' | 'anthropic'
  "path": "/v1/messages",
  "translation_notes": [...] | null,    // populated on anthropic → openai translation
  "body": { ...raw JSON body... },      // full request body OR full response body
  "sse_chunk": "...",                   // populated when kind='chunk'
  "usage": { "input_tokens": 823, "output_tokens": 214 } | null,   // populated on 'response' terminal
  "latency_ms": 1247 | null,
  "cost_usd": 0.00347 | null,
  "http_status": 200 | null
}
```

**`traffic.md` mirror.** Regenerated on demand (`c1 runs show <id>`), streaming from `traffic.jsonl`. One `## Session <id>` block per session, with request/response pairs formatted as fenced code blocks + collapsed usage summaries. Diff-friendly; PR-attachable. Not the source of truth — always derived.

**`meta.json`** — a snapshot of the config at run start, so `--continue` doesn't rely on the current `config.json` (which the user might have edited between the interrupted run and the resume).

### 15.3 Crash resume

`c1 run --continue <run_id>` behavior:

1. Load `meta.json` from `.c1/runs/<run_id>/meta.json` (fail with a clear error if missing).
2. Query SQLite for `SELECT session_id, task_id, lane, repeat_ix, status FROM sessions WHERE run_id = ?`.
3. Sessions with `status = 'complete'` (verification exit code + judge verdict both recorded): skip.
4. Sessions with `status IN ('running', 'queued')`: mark as `aborted`, add to the pending queue.
5. Sessions from `meta.json`'s expected set that aren't in SQLite at all: add to pending.
6. Run the pending set from scratch (per-session), appending to the **same** `traffic.jsonl` (with a `{"kind":"resume-marker","ts":...,"note":"..."}` divider row).
7. If SQLite is missing or corrupted, replay `traffic.jsonl` into a fresh SQLite before resuming.

**Trade-off recorded:** we do NOT support resuming individual steps within an in-flight session — if a subprocess dies mid-turn, the whole session restarts from step 0. Rationale: agent trajectories are non-deterministic; restarting mid-trajectory would corrupt the comparison signal.

### 15.4 Retention

- `traffic.jsonl` never deleted automatically. User-owned; they can `rm -rf .c1/runs/<id>/` to reclaim.
- `traffic.md` regenerable anytime from `.jsonl`.
- Iter3 will add a `c1 runs prune --older-than=30d` command. Iter2 leaves everything.

## 16. TUI runner controls

### 16.1 LiveProgress — during-run controls

The iter0 LiveProgress screen already renders (lane × task) cells. Iter2 replaces its fixture `tick()` with real events streamed from the runner's event bus (in-process pub/sub; runner emits, LiveProgress subscribes):

- **queued** → **running** the moment the subprocess spawn resolves (fires from `runner/subprocess.ts`)
- **running** → cell displays live token count + cost + elapsed as `steps` rows commit
- **pass / fail / error** when the session terminates AND the judge verdict lands in `classifier_tags`

Keyboard controls while the run is executing:

| Key | Action | Semantics |
|---|---|---|
| `p` | pause queue | in-flight sessions finish; no new sessions dispatched. State persists — resume with `p` again or `r`. |
| `r` | resume | opposite of pause. |
| `k` | kill focused cell | SIGKILL that specific (task × lane × repeat)'s subprocess; marks `failure_class = user_killed`. Sibling sessions unaffected. |
| `K` (shift-k) | kill lane | drops all pending sessions for the focused lane; in-flight ones for that lane get SIGKILL'd; other lanes continue. |
| `x` | abort run | SIGKILL every subprocess, mark run `status = aborted`, close proxy sockets, exit run loop. TUI stays open so user can review what completed. |
| `c` | raise cost cap | opens the inline cap editor (same pattern as Confirm.tsx). Applies to sessions dispatched after commit. |
| `↑↓` | move focus between cells | cell borders highlight; details panel updates |
| `d` | drill into focused cell | opens the SessionInspector (§16.2) live-tailed at the last step of that session. Continues to update as the session progresses. |
| `enter` | after run terminates | opens the RunBrowser (§16.3) rooted at this run |
| `q` | quit c1 | prompts confirm if a run is in-flight (pauses first) |

**Signal safety:** all subprocess kills flow through a single central handler that also removes the git worktree. LiveProgress never forks. If the c1 process itself gets SIGINT/SIGTERM, the same central handler runs (best-effort cleanup, no zombie subprocesses).

### 16.2 SessionInspector — drill into a session

**New screen.** Opens via `d` from LiveProgress, or from RunBrowser. Rows:

- Header: session_id, task, lane (model + destination), status, cost, elapsed, judge verdict (if landed)
- Step timeline: `step_ix` · `finish_reason` · latency · cost · tool_calls count. Scrollable.
- Selected step detail pane: full request body (collapsed by default), full response body, `translation_notes` if the Anthropic translator dropped anything. Reads from `traffic.jsonl` via the byte-range recorded in `steps.traffic_log_offset` — instant even for huge sessions.

Live-tail behavior: if the session is still running when the user opens the inspector, new steps append to the timeline as they commit; the detail pane sticks to whichever step the user selected (doesn't chase the cursor).

Keyboard:

| Key | Action |
|---|---|
| `↑↓` | move step selection |
| `enter` | expand the selected step's request+response bodies inline |
| `j` | jump to the judge's classifier_tags for this session (if landed) |
| `t` | filter timeline to tool-call steps only |
| `b` | back to whichever screen called us (LiveProgress or RunBrowser) |
| `q` | quit c1 |

### 16.3 RunBrowser — post-run navigation

**New screen.** Two entry points: `c1 runs` (subcommand, direct browse), or auto-opens when a LiveProgress run terminates.

- Left pane: list of runs from `<repo>/.c1/runs/` sorted by `started_at` desc. Each row: run_id short-hash, started_at, status, sessions completed/total, total spend.
- Right pane (when a run is focused): summary — lane matrix with per-lane pass/fail/cost/latency-p50 numbers. Row per lane, col per task.
- `enter` on a lane × task cell → SessionInspector rooted at that session (or the first repeat).

Keyboard:

| Key | Action |
|---|---|
| `↑↓` | select run (left pane) |
| `→` / `l` | move focus into the lane matrix |
| `←` / `h` | back to run list |
| `enter` | on a matrix cell → SessionInspector; on a run row → focus the matrix |
| `/` | filter run list by run_id / date substring |
| `q` | quit c1 |

### 16.4 Reports — deferred to a separate SPEC

Aggregate reporting (heatmap PNG, HTML index, cost-per-outcome roll-ups, shareable exports, cross-run comparison) is **out of iter2 scope**. Iter2 produces:

- The wire log at `<repo>/.c1/runs/<run_id>/traffic.jsonl` (source of truth)
- The SQLite index at `<repo>/.c1/db.sqlite`
- Per-session Markdown at `<repo>/.c1/runs/<run_id>/sessions/<session_id>.md` (regenerable from the JSONL; useful for grep + PR-attach)
- The RunBrowser TUI (§16.3) as the in-tool navigation surface

A separate SPEC (`c1-report-<date>-SPEC.md`) will design:
- The money-shot cost-per-outcome heatmap (rows = lanes, cols = tasks, cells = `$/pass`)
- HTML index at `<repo>/.c1/reports/<run_id>/index.html`
- `summary.md` markdown table format
- `heatmap.png` for Slack/PR embed
- Cross-run trend view (v0.1)

That SPEC will consume iter2's SQLite + JSONL as inputs — no changes to iter2's storage layer.

## 17. CLI additions (Part B)

- `c1 run` — new subcommand. Enters runner mode instead of the TUI. Requires prior `c1` walkthrough (KeySetup → Onboarding → Summarize → MethodologyCheck → PickTasks → PickModels → PickDestinations → Confirm) to populate config. Config gets locked into `.c1/runs/<run_id>/meta.json` at invocation time.
- `c1 run --continue <run_id>` — resume an interrupted run using the meta + traffic log at `.c1/runs/<run_id>/`. See §15.3.
- `c1 runs` (no args) — opens the RunBrowser TUI (§16.3). Interactive browse + drill into SessionInspector.
- `c1 runs list` — non-interactive: print all `<repo>/.c1/runs/*` with status (complete / partial / aborted), start time, session counts.
- `c1 runs show <run_id>` — non-interactive: regenerate + print `.c1/runs/<run_id>/traffic.md` from `traffic.jsonl`. Pass `--session <session_id>` to filter.
- `c1 runs prune` — **deferred to report SPEC.**
- Existing `c1` (no subcommand) stays the TUI entry — walks through Config screens as today. `Confirm.startRun` shells to `c1 run` behind the scenes.

## 18. Files to create/modify (Part B)

- `src/proxy/manager.ts` **new** — allocation, lifecycle, port bookkeeping.
- `src/proxy/lane.ts` **new** — per-lane HTTP server (Node `http`), request rewrite, SSE passthrough, step recording.
- `src/proxy/translate-anthropic.ts` **new** — Anthropic ↔ OpenAI translator (request + streaming response). See §12.3.
- `src/runner/worktree.ts` **new** — `git worktree add/remove`, deps-cache symlink.
- `src/runner/subprocess.ts` **new** — spawn with env, timeout, signal handling, step accumulation.
- `src/runner/orchestrator.ts` **new** — the outer for-loop: (task, lane, repeat) triples → sessions.
- `src/runner/traffic-log.ts` **new** — append-only JSONL writer, resume helper, MD regenerator. See §15.2.
- `src/runner/resume.ts` **new** — `--continue` flow: meta + SQLite + jsonl replay. See §15.3.
- `src/judge/haiku-r5.ts` **new** — prompt + call + validation.
- `src/judge/prompt-haiku-r5.md` **new** — prompt text (checked in for reproducibility).
- `src/db/sqlite.ts` **new** — schema, migrations, insert/query helpers.
- `src/screens/LiveProgress.tsx` — replace tick fixture with real event stream from the runner + all §16.1 during-run controls.
- `src/screens/SessionInspector.tsx` **new** — §16.2 drill-in screen; reads SQLite + `traffic.jsonl` byte ranges.
- `src/screens/RunBrowser.tsx` **new** — §16.3 post-run navigation, list runs + lane matrix + drill-to-inspector.
- `src/runner/event-bus.ts` **new** — in-process pub/sub between runner and TUI screens (session state transitions, step commits, judge verdicts).
- `src/cli.tsx` — `c1 run` + `c1 runs` (interactive browser) + `c1 runs list|show` subcommand plumbing.
- `src/state/store.ts` — real cell state driven by runner events (not the current mock tick).
- `package.json` — bump `engines.node` to `>=22`.

## 19. Test targets (Part B)

**Exit criterion:** one real comparison run against `job-search-automation` with the following setup, completed successfully with real data in `.c1/db.sqlite`:

| Lane | Model | Destination |
|---|---|---|
| 1 | `deepseek/deepseek-v4-flash` | `deepinfra/fp4` |
| 2 | `deepseek/deepseek-v4-flash` | `deepseek` (first-party) |
| 3 | `z-ai/glm-5.2` | `baseten/fp8` |

Tasks: the 2 LLM-classified tests already summarized (`test/e2e.test.cjs`, `test/judge.test.cjs`).
Repeats: 3.
Total sessions: **18**.
Estimated cost: ~$0.30 destination + ~$0.09 judge ≈ **$0.40**.

Success signals:
- 18 rows in `sessions`, ~150 rows in `steps` (varies with agent trajectory length)
- LiveProgress cells all reach a terminal state (pass/fail/error) within 20 minutes wall-clock at parallelism=3
- `<repo>/.c1/runs/<run_id>/traffic.jsonl` populated with per-turn bodies (§15.2 requirement)
- `c1 runs show <id>` regenerates a readable Markdown mirror
- SessionInspector opens on any completed session and renders the full step timeline from the JSONL byte ranges
- Non-zero pass rate on at least one lane (validates end-to-end)
- **Resume validation** — kill mid-run after ≥1 session completes, `c1 run --continue <id>` finishes the remaining sessions without re-running the complete ones. Final `traffic.jsonl` has a `resume-marker` divider row.
- **Controls validation** — during a run, `k` on a focused cell kills that session only (siblings continue); `x` cleanly aborts the whole run; `d` opens SessionInspector with a live-tailing timeline.

**Explicitly out of scope for iter2 exit:** heatmap PNG, HTML report, aggregate cost-per-outcome tables. Those land in the report SPEC (§16.4).

## 20. Pty test scenarios added

- `K` — MethodologyCheck ready state (fresh clean repo) auto-advances
- `L` — MethodologyCheck blocked state (synthetic hardcoded-repo) renders block + suggested env var
- `M` — proxy lane spins up on ephemeral port, OpenAI-compat `curl` against `/v1/chat/completions` rewrites model correctly, closes cleanly
- `N` — proxy lane serves `/v1/messages` (Anthropic native), translator emits valid OpenAI-shape upstream, returns valid Anthropic-shape downstream
- `O` — end-to-end `c1 run` in a synthetic 1-task fixture, populates `db.sqlite` AND `traffic.jsonl`, terminates cleanly
- `P` — resume path: kill `c1 run` mid-flight after 1 session completes, `c1 run --continue <id>` skips completed, reruns aborted, final state matches un-killed baseline
- `Q` — LiveProgress controls: `p` pauses queue (no new spawns), `r` resumes, `k` on focused cell kills that session only, `x` aborts run cleanly
- `R` — SessionInspector: `d` from LiveProgress opens inspector; step timeline populates; `enter` on a step expands request/response body; `b` returns
- `S` — RunBrowser: `c1 runs` opens the browser; select a run; lane matrix renders; `enter` on a cell drills into SessionInspector

---

## 21. SPEC drift owed

After iter2 ships:

- **Parent SPEC** — update §14 destination table to reflect real iter1 endpoints (via OR only for iter2; direct providers still iter5).
- **iter1 SPEC** — mark `LiveProgress still fixture-driven` note as resolved.
- **Parent SPEC §16** — mark iter1 done, iter2 done, update iter3 target.
- **This SPEC** — add amendment(s) for any decisions discovered during build.
- **New SPEC needed:** `c1-report-<date>-SPEC.md` for aggregate reporting (§16.4). Reads iter2's `db.sqlite` + `traffic.jsonl`. Owner: TBD, immediately after iter2 exit-criterion passes.

## 22. Provenance

- Design conversation: session `c1-bld-2807-1`, 2026-07-28
- Parent SPEC: `c1-local-SPEC-2707-v0.md`
- Predecessor SPEC (shipped): `c1-firstrun-28july-SPEC.md`
- Test target repos: `~/Documents/GitHub/job-search-automation` (real Node repo, Anthropic SDK), `~/Documents/GitHub/canaryone-cloud` (Vercel AI SDK)
