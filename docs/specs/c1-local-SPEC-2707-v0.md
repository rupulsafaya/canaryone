# CanaryOne Local — Build-Execution SPEC 2707-v0

**Date:** 2026-07-27
**Version:** v0 (local TUI + reverse-proxy capture + task-replay comparison)
**Author:** Rupul Safaya + Claude (interview-driven, session `c1-sdk-design`)
**Design context:**
- [canaryone-cloud/canaryone-intro.md](https://github.com/rupulsafaya/canaryone-cloud/blob/main/canaryone-intro.md) — hosted-product framing (stays as showcase)
- [canaryone-cloud/canaryone-SPEC-2507-v0.md](https://github.com/rupulsafaya/canaryone-cloud/blob/main/canaryone-SPEC-2507-v0.md) — hosted-product build spec (parent; components carry over)
- Handwritten notes: `~/Downloads/IMG_5797.jpg` (session `c1-sdk-design`)

**Companion repo:** [rupulsafaya/canaryone-cloud](https://github.com/rupulsafaya/canaryone-cloud) — the hosted OR-Broadcast dashboard, live at [canaryone-theta.vercel.app](https://canaryone-theta.vercel.app). Feature-frozen as showcase per §16.

---

## §1 — Overview + One-liner

**One line:** *A local CLI you point at your agent codebase to find which model + host runs it best (cost, speed, reliability) — on your code, on your tasks, on your machine. Nothing leaves the box.*

The hosted CanaryOne product (`canaryone-theta.vercel.app`) infers cost-per-outcome from OR Broadcast traffic — pull-model, dashboard-driven, single-tenant dogfood. **CanaryOne Local inverts that**: the customer clones a CLI, points it at their agent repo, and replays their own regression tests across N models/hosts through a localhost proxy. Trust-first: no cloud in v0.

The two products share their conceptual core (session/task/step schema, judge, cost/outcome metric semantics) but ship as separate artifacts.

---

## §2 — Non-goals (v0, defended)

- **No cloud sync**, even opt-in. Preserves the trust pitch cleanly; the "Claude account connect" story is v2+.
- **No automatic model recommendation.** Show the data, let the user decide. Sidesteps the "recommendation was wrong on my workload" bug class.
- **No prompt optimization or auto-suggestion.** C1 tests the code as-is. Braintrust does prompt optimization; we don't.
- **No browser/UI agent support.** CLI + SDK + framework agents only. Real Puppeteer testing of web-driven agents is a different product.
- **No CI-native integration in v0.** The design keeps the door open (deterministic runs, artifact outputs), but shipping GitHub Actions / GH checks is deferred.
- **No cross-run analytics UI** (branches, PRs, historical trend). Single-run report only in v0.

---

## §3 — User journey

**One command, whether it's the first run or the hundredth:**

```
$ cd my-agent-repo
$ npx canaryone
```

(Or, once: `npm i -g canaryone` — then `c1` from anywhere. Both invocations resolve to the same `bin`.)

**First-run onboarding** (auto-detected: `.c1/` does not exist). Everything inline in the TUI, no separate `init` subcommand:

```
  ┌───────────────────────────────────────────────────────────┐
  │ canaryone · my-agent-repo · first-run setup               │
  ├───────────────────────────────────────────────────────────┤
  │ OpenRouter API key                                        │
  │   ✓ Using $OPENROUTER_API_KEY from environment            │
  │     (or, if unset: masked TUI prompt → written to .c1/.env│
  │      which is added to .gitignore)                        │
  │                                                           │
  │ Scanning repo …                                           │
  │   ✓ Detected runner: pnpm test                            │
  │   ✓ 18 agent-relevant tests (of 47 total)                 │
  │   ✓ Fetched OR catalog (503 models, $12.40 credits left)  │
  │                                                           │
  │ Ready. Press Enter.                                       │
  └───────────────────────────────────────────────────────────┘
```

**Then the main TUI opens straight into task/model selection:**

```
  ┌───────────────────────────────────────────────────────────┐
  │ canaryone · my-agent-repo                                 │
  ├───────────────────────────────────────────────────────────┤
  │ ▸ Pick tasks           (18 detected, 0 picked)            │
  │ ▸ Pick models          (0 selected)                       │
  │ ▸ Confirm & run                                           │
  └───────────────────────────────────────────────────────────┘
```

**What happens on first run:**

1. **Get OR API key.** Read `$OPENROUTER_API_KEY` (OR's own convention) or `$OR_KEY`. If neither is set, TUI shows a masked-input prompt; the entered key is written to `.c1/.env` and `.c1/.env` is added to the repo's `.gitignore`. **One key covers destination + judge by default**; users who want cost-accounting separation can set `OR_JUDGE_KEY` in `.c1/.env` after the fact (documented in §11).
2. **Automatic scan.** Deterministic pass (package.json / pyproject / Makefile) + LLM-classified pass (using the OR key against Haiku) to detect:
   - How to run the agent headlessly (`npm run dev`, `python agent.py`, custom entrypoint)
   - How to run the test suite (`pnpm test`, `pytest`, `nx test`)
   - Which existing tests exercise the agent (LLM classifies each test file: "agent regression" vs "non-agent unit test — e.g. Stripe pre-auth check")

   Results cached to `.c1/scan.json`. Re-scan on `--rescan` or automatically if `package.json` mtime is newer than the cache.

3. **Fetch OR catalog** (`GET /api/v1/models` + `GET /api/v1/key` for credit balance). Cached 24h in `.c1/model-catalog.json`.

4. **Write `.c1/config.json`** with the resolved runner + entrypoint + scan results.

Steps 1–4 run in one Ink render pass. From the user's perspective it's **one command → one setup screen → main TUI.**

**Subsequent runs** skip the onboarding; TUI opens directly to task/model selection using cached scan + config.

**Main-TUI flow** (each step gets its own subsection below):

### §3.5 — Pick tasks

TUI presents the list of **already-classified agent-relevant tests** produced by the first-run scan (§3 step 2). Non-agent tests (Stripe pre-auth checks, DB migration integrity, plain unit tests) never appear — the LLM classifier drops them at scan time.

Each row shows:
- Test file path + `it()`/`describe()` name
- Classifier confidence (`0.72`)
- One-line summary of what the test exercises (from the same LLM pass)

User navigates the list with arrow keys and toggles inclusion with space. `a` = select all; `n` = select none.

**Selection is persistent.** The set of included task IDs is written to `tasks_meta.included_at` in `.c1/db.sqlite` on any change. On the next `npx canaryone` invocation, the picker opens with the previous selection pre-checked. **The user never re-scans, re-classifies, or re-selects unless they want to** — the flow for a returning user is one command → confirm & run.

Explicit rescans available via `--rescan` flag (invalidates scan cache, re-runs classification). Automatic rescan triggers on `package.json` mtime > cache mtime.

**v0 assumption:** at least one agent-relevant test exists in the target repo. If the classifier finds zero: C1 emits a single actionable error (`"No agent-relevant tests detected. C1 v0 requires at least one — see docs. Task authoring in the TUI is coming in v0.1."`) and exits non-zero. **Fallbacks (delete-and-recover, test-name-as-prompt, TUI wizard) are deferred to v0.1** and covered as future work in §7.

### §3.6 — Pick models

Two data sources fetched during first-run onboarding (§3 step 3), refreshed on `--refresh-catalog` or every 24h:

1. **`GET https://openrouter.ai/api/v1/models`** — full catalog: model slug, per-token pricing (input/output/cached), context window, provider info. Documented public API.
2. **`GET https://openrouter.ai/api/frontend/v1/rankings/models?view=day&models=all`** — usage rank across all OR traffic. Returns `{ data: [{model_permaslug, variant, total_prompt_tokens, total_completion_tokens, count, change, ...}] }`. Sort by `count` desc = "most popular today". *Undocumented `frontend/v1` endpoint — small risk of URL change; C1 falls back to unranked-alphabetical if the endpoint 404s.*

The picker joins these two: rank order + pricing + context on each row.

**Layout:**

```
  ┌───────────────────────────────────────────────────────────────────────┐
  │ canaryone · my-agent-repo · Pick models                               │
  ├───────────────────────────────────────────────────────────────────────┤
  │ Most used on OpenRouter (today)                                       │
  │  [x] xiaomi/mimo-v2.5              1.52T tok  ↑5%  $0.15/$0.60/1M     │
  │  [x] deepseek/deepseek-v4-flash    1.03T tok  ↑9%  $0.20/$0.80/1M     │
  │  [ ] tencent/hy3                   597B tok   ↑1%  $0.30/$1.20/1M     │
  │  [ ] deepseek/deepseek-v4-pro      493B tok   ↑19% $0.40/$1.60/1M     │
  │  ... top 20                                                           │
  │                                                                       │
  │ All models (alphabetical, /search)                                    │
  │  [ ] 01-ai/yi-large                                    $0.30/$0.90/1M │
  │  [ ] ai21/jamba-large-1.7                              $0.50/$0.70/1M │
  │  [ ] amazon/nova-micro-v1                              $0.04/$0.14/1M │
  │  ... searchable via /                                                 │
  ├───────────────────────────────────────────────────────────────────────┤
  │ 2 selected · Est. 8 tasks × 2 models × 3 repeats = 48 runs ≈ $3.20    │
  └───────────────────────────────────────────────────────────────────────┘
```

Selection is persisted to `.c1/db.sqlite:selected_models` per repo. Returning users see their last selection pre-checked.

**Pre-flight cost estimate** (bottom bar): live counter that recomputes on every add/remove. Formula:

```
est_cost = Σ (over selected models × selected tasks × repeats)
             (baseline_input_tokens × input_price + baseline_output_tokens × output_price)
           + judge_cost_per_task × N_tasks × N_models × N_repeats
```

`baseline_input_tokens` / `baseline_output_tokens` are per-task averages seeded from iter2 fixture data. After the first real run in this repo, C1 replaces the baseline with observed averages per task — subsequent estimates get more accurate.

**Deferred to v0.1: Pick provider stage.** OR is the only destination in v0, so provider = OR is implicit. When direct-API destinations (Nebius, Baseten, Anthropic-direct) land in v0.1, a "Pick provider" step slots in between "Pick models" and "Confirm & run" — for each selected model that has multiple viable destinations, the user chooses which. See §14 for the destination abstraction.

### §3.7 — Confirm & run

Before running, the TUI shows the **full breakdown** — not just a total. Users need to see the math before committing spend.

```
  ┌───────────────────────────────────────────────────────────────────────┐
  │ canaryone · my-agent-repo · Confirm & run                             │
  ├───────────────────────────────────────────────────────────────────────┤
  │ Scope                                                                 │
  │   8 tasks × 3 models × 1 provider (OR) × 3 repeats = 72 runs          │
  │                                                                       │
  │ Time                                                                  │
  │   ~ 90 s median per run × 72 = ~1h 48m sequential                     │
  │   With parallelism = 3: ~ 36 min wall-clock                           │
  │                                                                       │
  │ Cost                                                                  │
  │   Destination LLM  (OR list × baseline tokens):     ~ $3.80           │
  │   Judge model      ($0.005 × 72 tasks judged):      ~ $0.36           │
  │   ────────────────────────────────────────────────────────────        │
  │   Total estimated:                                  ~ $4.16           │
  │                                                                       │
  │ Guardrail: hard cap at $10.00 (--max-spend override)                  │
  │                                                                       │
  │ [ Run ]    [ Change task selection ]    [ Change models ]    [ Quit ] │
  └───────────────────────────────────────────────────────────────────────┘
```

Numbers are all estimates. Time uses `p50_run_duration_ms` from prior runs on this repo (fallback: iter2 baseline). Cost uses the same formula as §3.6 with a judge-cost line added.

### §3.8 — Live progress

**Grayscale-filling table**, one row per model, one column per task. Cells start empty and fill in as work completes. This becomes the money-shot heatmap by the end — the live view IS the report, being drawn in real time.

```
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │ canaryone · my-agent-repo · Running  ·  9/24 done  ·  $1.42 spent  · ~22m left   │
  ├──────────────────────────────────────────────────────────────────────────────────┤
  │                    t1  t2  t3  t4  t5  t6  t7  t8   pass  spend    ETA           │
  │  haiku-4.5         ██  ██  ██  ▓▓  ··  ··  ··  ··   3/3   $0.42    ~6m           │
  │  sonnet-4.6        ██  ██  ▒▒  ▓▓  ··  ··  ··  ··   2/3   $0.71    ~8m           │
  │  deepseek-v4-flash ██  ██  ██  ██  ▓▓  ··  ··  ··   4/4   $0.29    ~7m           │
  │                                                                                  │
  │  Legend:  ··  queued   ▓▓  running   ██  passed   ▒▒  failed   ▚▚  error         │
  │                                                                                  │
  │  Current: haiku-4.5 on t4  ·  step 7/12  ·  $0.03 self-reported                  │
  │  Press [q] to soft-stop (finish in-flight, write partial report)                 │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

**Cell semantics:**
- `··` (two dots) — queued, work not started
- `▓▓` (dark shade) — currently running; animated spinner via alternating shades
- `██` (full block, green in a color-capable terminal) — task passed
- `▒▒` (medium shade, red in color) — task failed
- `▚▚` (diagonal) — infra error (rate-limit exhausted, timeout, cost cap); not a real model failure

**Right-side columns:**
- `pass` — passed / total-attempted so far for this model
- `spend` — cumulative $ for this model
- `ETA` — remaining wall time for this model given current pace

**Header line:** overall progress + cumulative spend + wall-clock ETA. Updates every second.

**Ctrl-C / `q`:** soft-stop — no new work spawned, in-flight runs allowed to finish, partial report written to `.c1/reports/<timestamp>/`. Second Ctrl-C = hard-kill (SIGKILL all workers, DB left in `status=aborted`, resumable via `c1 resume <run_id>` if implemented).

The final frame of this view IS the money-shot heatmap (§13). The report just captures it to `heatmap.png` and writes accompanying HTML/MD/JSONL.

### §3.9 — Report

Money-shot heatmap frozen in the TUI + full report written to `.c1/reports/<timestamp>/`:

- `index.html` — self-contained, offline-openable, includes heatmap + KPI cards + per-session drilldowns
- `summary.md` — same numbers as markdown tables (diff-friendly, PR-attachable, LLM-friendly)
- `raw.jsonl` — every step's request/response/timing/cost + judge output (power-user grep)
- `heatmap.png` — the money shot alone, standalone image (Slack/PR-friendly)

TUI displays the report path and offers `[ Open in browser ]` (opens `index.html`), `[ Copy path ]`, `[ Run again ]` (returns to task/model selection with previous selection intact).

**What lives in `.c1/` (all gitignored by default):**

```
.c1/
├── .env                    # OPENROUTER_API_KEY (masked input result); optional OR_JUDGE_KEY
├── config.json             # runner, entrypoint, scan hash
├── db.sqlite               # runs, sessions, steps, tasks, classifier_tags
├── model-catalog.json      # cached OR /models response
├── scan.json               # cached repo scan results
├── deps-cache/             # node_modules for worktree symlinks (installed once)
├── worktrees/              # git worktrees per (model, task, repeat); auto-cleaned
├── reports/<timestamp>/    # index.html, summary.md, raw.jsonl, heatmap.png
└── tasks.json              # user-authored + accepted-from-scan task defs
```
>>>
---

## §4 — Architecture

```
                              ┌────────────────────────┐
                              │  User's agent codebase │
                              │  (my-agent-repo/)      │
                              └────────────┬───────────┘
                                           │  spawn subprocess in fresh worktree
                                           ▼
             ┌─────────────────────────────────────────────┐
             │  Agent process                              │
             │  OPENAI_BASE_URL=http://localhost:11434     │
             │  ANTHROPIC_BASE_URL=http://localhost:11434  │
             │  OPENROUTER_BASE_URL=http://localhost:11434 │
             └────────────┬────────────────────────────────┘
                          │  outbound LLM request
                          ▼
             ┌────────────────────────────┐
             │ c1 local reverse proxy     │
             │ localhost:11434            │
             │ - rewrites model slug      │◄── which model to swap in
             │ - records req/resp/timing  │      (per-run config)
             │ - forwards to destination  │
             └────────────┬───────────────┘
                          │
              ┌───────────┴─────────────┐
              │                         │
              ▼                         ▼
           OpenRouter          Direct provider APIs
                                (Nebius, Anthropic,
                                 Baseten, ... — v0.1+)

  Recorded traces → .c1/db.sqlite → judge (BYOK) → tags → report
```

**Key architectural constraints:**
- The proxy uses **env-var swap only** (no MITM cert install). All major LLM SDKs honor `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `OPENROUTER_BASE_URL`. Repos with hardcoded URLs are unsupported in v0 (documented as a limitation).
- All destinations are addressed via **OpenAI-compatible /v1/chat/completions**. OR is natively that shape. Direct providers wrapped by LiteLLM-style adapters (v0.1). Bedrock via AWS SDK behind the same interface (v0.2+).
- **Task replay** is the only comparison mechanism. No fan-out, no trace replay, no hybrid.
- **Git worktree per (model, task, repeat)**. Reuses iter2's pattern. `node_modules` symlinked once from `REPO/.c1/deps-cache/` into each worktree.

---

## §5 — Capture layer (localhost reverse proxy)

**Endpoint:** `http://localhost:11434` (Ollama's default — familiar, unused by OpenAI/Anthropic/OR).

**Supported inbound shapes:**
- OpenAI chat completions (`POST /v1/chat/completions`)
- Anthropic messages (`POST /v1/messages`) — translated to OpenAI shape internally
- OpenRouter chat completions (`POST /api/v1/chat/completions`)

**Per-request behavior:**
1. Parse inbound request. Record `(session_id, task_id, step_id)` from C1's run context (injected via a custom header the agent doesn't need to know about — the proxy adds it based on which worktree the subprocess is running in).
2. Rewrite the `model` field to the model being tested this run.
3. Forward to the destination (OR by default; direct provider if the model slug maps to one).
4. Stream response back to the agent. Simultaneously record the full request+response+timing+usage to `.c1/db.sqlite`.
5. On rate-limit (429), exponential backoff up to `--max-retries` (default 3). On terminal failure, surface to the driver, mark step failed.

**What we do NOT do:**
- No MITM TLS interception. Hardcoded URLs are not supported in v0.
- No prompt/response mutation beyond the model slug swap.
- No provider fallback within a single step (breaks the pinning semantic). If the destination fails, the step fails.

---

## §6 — Codebase scan + agent-entrypoint detection

**Two-pass detection:**

**Pass A — deterministic:**
- `package.json` → look for `scripts.dev`, `scripts.start`, `scripts.agent`, `scripts.test`, `scripts["test:unit"]`, `scripts["test:e2e"]`.
- `pyproject.toml` / `setup.py` → look for entry_points, scripts.
- `Makefile` → parse targets named `test`, `run`, `agent`.
- Framework fingerprints: `next.config.*`, `nx.json`, `langchain.yaml`, `mastra.config.*`, `.opencode/` dir → tag repo kind.

**Pass B — LLM-classified (uses `OR_JUDGE_KEY`):**
- Feed the judge model: README.md, top-level file tree, package.json/pyproject snippets.
- Ask: (1) which command runs the agent headlessly, (2) which command runs the tests, (3) classify each test file as "agent regression test" vs "non-agent unit test". Structured output.
- Cost: ~$0.01 per repo scan. Cached in `.c1/scan.json` — re-scan on `c1 scan --force`.

**Agent-entrypoint contract (SDK apps):**
- If Pass A detects an obvious script (`npm run agent`, etc.), auto-populate `config.entrypoint`.
- Otherwise, TUI wizard prompts the user: "Which command runs your agent? (leave `$PROMPT` where the user's task should be substituted)". Example: `python agent.py --task "$PROMPT"`.
- Stored in `.c1/config.json:entrypoint`.

**Non-goal in v0:** repos that require Docker to run their agent. Documented as a limitation.

---

## §7 — Task discovery + authoring

**Primary source: existing tests classified as agent-regression tests.**

Assumption (per user): if you've built an agent, you have regression tests for it. Examples that qualify:
- Simple: `"When does flight KL1702 arrive?" → "KL1702 arrives at 6:30pm AMS time"`
- Complex: multi-step opencode-style trajectories where a fixture repo needs to be modified and a test suite passes.

**Test classification (LLM-driven):** Judge model reads test file, returns `{is_agent_regression: bool, task_prompt: str, verification_command: str, confidence: float}`. Non-agent tests (Stripe pre-auth verification, DB migration integrity, etc.) are excluded.

**TUI presents the classified list.** User checks the ones to include. Default: pre-check all agent-regression tests with `confidence >= 0.7`.

**Fallbacks when no tasks are detected (in priority order):**

1. **Delete-and-recover.** C1 offers to `git stash` the implementation of a picked function, tell the agent "make `tests/foo.spec.ts` pass", then `git stash pop` after the run. Turns any passing test into a task. Requires user consent per function.
2. **Test names as prompts.** For tests C1 can't verify with a command, use the test's `it()` / `describe()` string as an English spec, and use the pre-run failing state as ground truth. Weaker signal.
3. **TUI wizard step-by-step authoring.** Not YAML. Ink-based form: (a) prompt input, multi-line, (b) verification command input, (c) tags. Submit appends to `.c1/tasks.json` (never seen by the user directly). "Add another task?" loop.

**Stretch (v0.1):** Chat-with-C1 assistant. `c1 tasks draft` opens a chat: "Tell me what your agent does." The judge model drafts tasks from conversation + repo scan. User reviews before saving. Higher-magic UX, more tokens.

---

## §8 — Model catalog + selection

**Fetch OR catalog live at TUI start.** `GET https://openrouter.ai/api/v1/models`. Cache 24h in `.c1/model-catalog.json`. Also fetch `GET /api/v1/key` to display remaining credits + `is_free_tier` boolean.

**Curated presets ship in-tool:**
- **Cheap coding fleet** — `deepseek/deepseek-v4-flash`, `z-ai/glm-5.2`, `qwen/qwen-3-coder`
- **Frontier comparison** — `anthropic/claude-opus-4-7`, `anthropic/claude-sonnet-4-6`, `openai/gpt-5`, `google/gemini-3-flash` (or current)
- **GLM-5.2 host bake-off** — same model, pinned to `baseten/fp8`, `baseten/fast`, `fireworks`, `together`, `deepinfra/fp4`, `baidu` via per-invocation `provider.order`

**Freeform add:** searchable multi-select from the full OR catalog. Filter by price ($/1M in-out), context window, provider.

**Direct API keys (v0.1):** if the user has `NEBIUS_KEY`, `BASETEN_KEY`, `ANTHROPIC_KEY`, `OPENAI_KEY` in `.c1/.env`, C1 offers direct-API destinations for models those providers publish. Same interface, no OR markup.

**Other routers (v0.2+):** Bedrock, Vertex, Azure. Adapter per router behind the OpenAI-compat interface.

---

## §9 — Cost controls

Three layers, all mandatory for the trust pitch to hold.

1. **Pre-flight estimate.** Before starting a run, C1 shows:
   ```
   Selected: 5 models × 8 tasks × 3 repeats = 120 runs
   Estimated spend: $4.30 (OR list price × avg iter2 task token count)
   Cap: $10.00 (--max-spend)
   Judge cost: ~$0.60 (~$0.005/task × 120)
   ─────────────────────────────────────
   Total est: $4.90 · Continue? (y/N)
   ```
2. **Hard `--max-spend N.NN` cap.** Runner monitors cumulative self-reported cost from OR responses. Once the cap is hit, SIGKILL all in-flight subprocesses, mark remaining runs as skipped, write partial report. Reuses SPEC §17 driver safety nets.
3. **`--free-tier-only` mode.** Filter the model catalog to only free/near-free models (Qwen free tier, Gemini Flash-lite, etc). Great for the first-run demo. Users see the tool work before spending real money.

Additional per-step caps carried over from the hosted SPEC:
- 6-minute timeout per agent invocation with SIGKILL
- $0.50 self-reported cost cap per invocation
- 60 step_finish cap per invocation

---

## §10 — Comparison run mechanics

**Task replay only.** No fan-out. No trace replay.

**Per (model, task, repeat) run:**
1. Create fresh git worktree at `.c1/worktrees/<run_id>/`.
2. Symlink `.c1/deps-cache/node_modules` in (installed once by C1 before the batch starts).
3. Set env vars in the subprocess: `OPENAI_BASE_URL=http://localhost:11434`, `ANTHROPIC_BASE_URL=…`, `OPENROUTER_BASE_URL=…`, plus a custom `C1_RUN_ID=<uuid>` header injected via a request interceptor for correlation.
4. Spawn the agent per `config.entrypoint` with `$PROMPT` substituted.
5. Timeout: 6 min hard. Cost cap: $0.50 self-reported.
6. On completion, run the verification command (per-task) — exit 0 = pass, anything else = fail.
7. Judge model reads the transcript + repo diff + verification result, writes structured tags to `classifier_tags` (same schema as hosted SPEC).
8. Delete the worktree.

**Concurrency.** `--parallelism N` flag. Default = `min(models_selected, 8)`. Model-parallel, task-sequential per model.

**Rate-limit handling.** Exponential backoff on 429, up to `--max-retries=3`. If backoff exhausts, mark step failed with `failure_class=rate_limit`.

**Failure classifications (from hosted SPEC §17):** `cost_cap`, `step_cap`, `timeout`, `setup_patch_failed`, `rate_limit`, `entrypoint_missing`, `config_error`, `model_route_missing`, `network_error`, `verification_failed`, `unknown_error`. Every failure has a class; UI segregates verification failures (real signal) from infra failures (noise).

**Cleanup:** SIGINT/SIGTERM handlers clean worktrees + spawned procs + temp configs. No leftover state on Ctrl-C.

---

## §11 — Judge

**Same shape as the hosted SPEC's `scripts/judge_v1.ts`, ported to a library module in the CLI.**

- **Model:** `anthropic/claude-haiku-4.5` via BYOK `OR_JUDGE_KEY`. User can override to any judge model.
- **Prompt:** current is `2026-07-27-haiku-r5` from the hosted spec (finish_reason signal + wider tool_result window + file-re-read diff view).
- **Input per task:** initial prompt, full trajectory (LLM req/resp + tool results), repo diff, verification command result.
- **Output:** `success | failure | uncertain` + `failure_reason` + confidence.
- **When verification command is definitive** (test passes/fails), verification result is authoritative — judge is used only to explain WHY.
- **When verification is absent or ambiguous**, judge is authoritative.

**Judge cost:** ~$0.005 per task. For a 5-model × 8-task × 3-repeat run: 120 tasks × $0.005 = $0.60. Displayed separately from destination cost in the pre-flight estimate.

---

## §12 — Storage

**Location:** `<target-repo>/.c1/db.sqlite`. Gitignored by C1 during `init`.

**Rationale for repo-local (vs `~/.c1`):**
- Attribution is per-repo. `git diff main..HEAD` semantics come for free later.
- Portable — a user can share `.c1/db.sqlite` with a colleague for cross-machine reproduction.
- Prevents cross-project data leaks in case of accidental sharing.

**Schema (v0, adapted from hosted):**

```
runs                     — one row per `c1 run` invocation
  run_id                  UUID (PK)
  started_at              TIMESTAMP
  ended_at                TIMESTAMP
  models                  JSON  (array of model slugs selected)
  tasks                   JSON  (array of task IDs selected)
  repeats                 INT
  parallelism             INT
  max_spend               NUMERIC
  total_spend             NUMERIC
  status                  TEXT  (running / complete / aborted / capped)

sessions                 — one row per (model, task, repeat) subprocess
  session_id              UUID (PK)
  run_id                  UUID (FK → runs)
  model                   TEXT
  task_id                 TEXT
  repeat_ix               INT
  started_at              TIMESTAMP
  ended_at                TIMESTAMP
  status                  TEXT  (pass / fail / uncertain / error_<class>)
  self_reported_cost      NUMERIC
  worktree_path           TEXT  (deleted after run; kept for provenance)

steps                    — one row per LLM API round-trip within a session
  step_id                 UUID (PK)
  session_id              UUID (FK → sessions)
  step_ix                 INT
  model_requested         TEXT   (what we set)
  model_returned          TEXT   (what the destination reports; catches slug rewrites)
  provider_slug           TEXT   (baseten/fast, baidu, etc.)
  request_json            JSON
  response_json           JSON
  input_tokens            INT
  output_tokens           INT
  input_tokens_cached     INT
  cost_usd                NUMERIC
  latency_ms              INT
  finish_reason           TEXT

tasks_meta               — the task definitions used by a run
  task_id                 TEXT (PK)
  prompt                  TEXT
  verification_command    TEXT  NULL
  source                  TEXT  (existing_test / delete_and_recover / test_name / wizard / assistant)
  created_at              TIMESTAMP

classifier_tags          — judge outputs, same shape as hosted
  session_id              UUID
  dimension               TEXT
  value                   JSON
  classifier_version      TEXT
  PRIMARY KEY (session_id, dimension)
```

Migrations via `sql-lite` `PRAGMA user_version`. Ship one embedded migration; add versions as the schema evolves.

---

## §13 — Report + money shot

**In-TUI final view + `<repo>/.c1/reports/<run_id>/` on disk.**

**Money shot: cost-per-outcome heatmap (model × task).**
- Rows: models compared.
- Cols: tasks.
- Cell: `$ / pass` if any pass in this cell; gray + fail-count if no passes.
- Color: green (best-in-column) to red (>3× best-in-column). Gray = no successes.
- Sortable by model (row-total $/outcome), by task (per-column winner).
- Cell click (in HTML) drills into the session detail.

**Report directory contents:**
- `index.html` — self-contained page with the heatmap, KPI cards (total spend, pass rate per model, cheapest-per-outcome model), and per-session drilldowns. No external asset dependencies. Ships offline.
- `summary.md` — same numbers as markdown tables. Diff-friendly, LLM-friendly, PR-attachable.
- `raw.jsonl` — every step's request/response/timing/cost + judge output. For power users to grep.
- `heatmap.png` — the money shot, standalone, PNG. For Slack/PR.

**No historical trend view in v0.** Cross-run comparison (branch vs main, this week vs last) is a v0.1+ concern.

---

## §14 — Destination abstraction

**Single interface: OpenAI-compatible `/v1/chat/completions`.**

The proxy's outbound layer is a small pluggable-destinations module. Each destination implements:

```ts
interface Destination {
  slug: string                              // e.g. "openrouter", "anthropic-direct", "nebius", "bedrock"
  supports_model(model_slug: string): bool
  forward(req: OpenAIChatRequest, auth: DestinationAuth): Promise<OpenAIChatResponse>
  extract_cost(resp: OpenAIChatResponse): { input_cost, output_cost, cached_cost }
  extract_host(resp: OpenAIChatResponse): string | null
}
```

**v0 destinations:**
- `openrouter` — native pass-through.

**v0.1 destinations (behind the same interface):**
- `anthropic-direct`, `openai-direct` — Anthropic Messages / OpenAI native. Response translated to OpenAI-compat.
- `nebius`, `baseten`, `fireworks`, `together`, `deepinfra` — most already OpenAI-compat native.

**v0.2+:**
- `bedrock`, `vertex`, `azure` — via each vendor's SDK, wrapped.

**Model → destination routing:** rule table in `.c1/routing.json`. Default: everything routes through OR unless the user has explicit `<PROVIDER>_KEY` in `.env` AND the model slug matches a direct-route rule.

---

## §15 — Trust boundary + egress policy

**Local by default. Explicit egress list:**

Allowed and enabled by default:
- **LLM destination traffic** (OR, direct provider APIs). This is the whole point.
- **OR model catalog fetch** (`GET /api/v1/models`, `GET /api/v1/key`) — read-only, public.
- **Version-check** on startup (`GET https://c1.canaryone.dev/latest`). Fingerprints IP+UA. Documented; can be disabled via `C1_NO_VERSION_CHECK=1`.

Allowed but **opt-in on first run** with a clear TUI prompt:
- **Anonymous usage telemetry.** No repo paths, no prompts, no model choices — just "C1 ran; N models compared; N tasks; version." Prompt: `Send anonymous usage telemetry? (y/N)`. Choice saved to `~/.c1/telemetry.json`.
- **Crash/error reporting.** Same trust model. Only sends stack traces + version; scrubbed of any path/prompt content.

**Never sent, ever, in v0:**
- Prompts, responses, tool_call args, code snippets from the repo, file paths inside the repo.
- API keys.
- Task definitions.
- Judge outputs.
- Any content of `.c1/db.sqlite`.

**Documented in `README.md#privacy` at build time.** This is the trust artifact; it should be linkable and copyable.

---

## §16 — Relationship to hosted canaryone

The hosted product at `canaryone-theta.vercel.app` stays live as a **showcase** — public evidence that the metric works and the OTLP pipeline is real. It receives no new feature work in the c1-local-v0 window.

**What carries over from hosted to local (ported as library modules):**
- `lib/otlp.ts` — OTLP parsing + `isTitleGenTrace` filter. Adapted to read from proxy-recorded shape rather than OR Broadcast shape.
- `scripts/judge_v1.ts` → `packages/c1/src/judge/` — same haiku-r5 prompt, same versioning, same tag schema.
- Metric semantics: **cost per inferred outcome = total_spend / success_tasks_touched** (amortized). Locked; changing this breaks continuity with published hosted numbers.
- Session/task/step terminology. Task clustering rule (split on user-prompt-content-change, 5-min hard cap fallback).
- Driver safety nets — timeout, cost cap, step cap, failure classification, cleanup.

**What is genuinely new in local:**
- Reverse-proxy capture instead of OR Broadcast ingest.
- Task-input side (test discovery, LLM classification, wizard, delete-and-recover).
- TUI (Ink + Node).
- Local SQLite storage.
- Report generation (money-shot heatmap, index.html, summary.md).
- Model-picker + pre-flight cost estimator.
- Destination abstraction.

**What is deliberately dropped:**
- Supabase, Vercel deployment target, Next.js dashboard (all stay in the hosted repo, not ported).
- HMAC verification (irrelevant for a localhost proxy).
- Multi-tenancy (single-user by definition).
- Cron-scheduled auto-judge.

---

## §17 — Iteration plan (3-month beachhead)

**iter0 — repo scaffold + capture proof (week 1)**
- `npx c1 init` writes config, gitignore.
- Ink TUI shell with menu.
- Reverse proxy at localhost:11434 that forwards to OR and records to SQLite.
- Manual `c1 run` command with hardcoded task + model list.
- Exit criterion: real opencode session recorded into `.c1/db.sqlite` via proxy env-var swap.

**iter1 — task discovery + comparison run (weeks 2–3)**
- Pass A + Pass B repo scan.
- Test classification via judge.
- Model picker (OR catalog + curated presets).
- Git worktree per run + concurrency.
- Judge port from hosted → local library.
- Exit criterion: `npx c1 run` against a real user repo (initially `opencode` itself against iter2 fixtures), 3-model comparison, judged, complete run under $5.

**iter2 — report + trust artifact (week 4)**
- Money-shot heatmap.
- HTML report generator.
- Pre-flight cost estimate.
- `--free-tier-only` mode.
- README#privacy section + telemetry opt-in prompt.
- Exit criterion: shareable `report/index.html` a stranger can open and understand without help.

**iter3 — SDK-app support + wizard (weeks 5–6)**
- Entrypoint auto-detection + wizard fallback.
- Delete-and-recover task source.
- TUI task authoring wizard.
- Exit criterion: onboarding a non-opencode agent codebase (e.g. a Vercel AI SDK app) succeeds.

**iter4 — direct-API destinations (weeks 7–9)**
- Destination-adapter interface.
- Adapters for Anthropic-direct, OpenAI-direct, Nebius, Baseten, Fireworks.
- Routing rules per-model.
- Exit criterion: a run mixing OR + one direct provider produces clean apples-to-apples numbers.

**iter5 — polish + first external user (weeks 10–12)**
- Bug reports from iter3+iter4 usage.
- Any of the deferred v0.1 items that survive the bar.
- Exit criterion: at least one non-Rupul-Safaya user completes a run and finds it useful enough to describe unprompted.

---

## §18 — Open questions / deferred

Marked with `[open]` — none are v0 blockers, but each is worth a decision before it becomes one.

- **`[open]` Repos with hardcoded LLM URLs.** Env-var swap doesn't reach them. Options: (a) document as unsupported, (b) inject a preload (NODE_OPTIONS / PYTHONSTARTUP) that monkey-patches openai/anthropic SDKs. Decision deferred to iter3 when we hit a real repo that needs it.
- **`[open]` Judge model choice.** Haiku-r5 is the current default. Some users may want to bring a stronger judge (Sonnet, GPT-5) for high-stakes evals. Config surface exists (`config.judge_model`); the question is whether we ship any UI for it in v0 or defer.
- **`[open]` What happens when the agent's tests themselves are flaky.** Right now we count a fail as a fail regardless of provenance. Some flake-detection heuristic (rerun once on `error_<class>`, don't count reruns against the model) is worth having. Deferred to iter2.
- **`[open]` Cross-run comparison.** "Did this PR make my agent more expensive?" is the natural CI hook. Requires either historical DB retention or a lightweight artifact-diff mode. Deferred to v0.1.
- **`[open]` Distribution as a signed binary.** `npx c1` works for Node users. Non-Node users (Python-only shops) need something else. `pipx c1` via a Python shim? Homebrew tap wrapping the Node install? Deferred to iter5.
- **`[open]` Rate-limit handling per destination.** OR's paid-tier ceiling is generous; upstream provider limits vary widely. Backoff + retry works for v0. Per-destination rate-limit awareness (e.g. Baidu is aggressive) may need explicit tuning. Deferred.
- **`[open]` What we do when C1 itself crashes mid-run.** Currently: worktrees are orphaned, DB has an in-progress `run`. Resume-from-crash logic (`c1 resume <run_id>`) is a nice-to-have. Deferred to iter2.
- **`[open]` Package name on npm.** `c1` is taken (unrelated project). `@canaryone/c1`? `canaryone-cli`? `canaryone`? Decide before iter5 publish.

---

## §19 — Success criteria (v0)

The v0 ships when:

1. **Zero-config first run works.** `npx c1 init && npx c1` produces a report on a supported repo (opencode, one Vercel AI SDK example, one LangChain example) with < 5 min of user time and < $5 of spend.
2. **The trust artifact holds.** README#privacy is complete. Telemetry is prompt-on-first-run. `C1_NO_VERSION_CHECK=1` disables version check. Grepping the source tree for any egress URL surfaces exactly the URLs documented in §15.
3. **The money shot is shareable.** A generated `heatmap.png` + `summary.md` posted to Slack conveys the finding without a reader needing to install C1 or read the raw data.
4. **The metric matches the hosted product.** A comparison of `deepseek-v4-flash on Baidu` vs `glm-5.2 on baseten/fp8` on the iter2 fixture tasks produces numbers within 20% of the hosted CanaryOne's published figures. This is the cross-validation that says "same tool, different capture layer, same truth."
5. **At least one non-Rupul-Safaya user has completed a run and given feedback.** Not a metric — a signal.

---

## §20 — Changelog

- **2026-07-27, v0 initial** — Interview-driven scope from session `c1-sdk-design`. Design decisions locked (§4–§14). Hosted product designated as showcase (§16). Non-goals defended (§2). Beachhead 3-month iteration plan (§17).
