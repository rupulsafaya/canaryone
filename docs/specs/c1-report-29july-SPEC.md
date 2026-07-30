# canaryone launch — SPEC 2 (HTML report)

**Status:** proposed 2026-07-29. Owner: **Bhaskar**.
**Companion spec:** [`c1-launch-29july-SPEC.md`](./c1-launch-29july-SPEC.md) — runner (multi-router + judge), owned by Rupul.

**Reading order:** parent SPEC (`c1-runner-28july-SPEC.md` §15 — storage layout) → this doc.

---

## 1. Purpose

canaryone's runner captures every request/response byte to `.c1/runs/<runId>/traffic.jsonl` and indexes aggregate state in `.c1/db.sqlite`. This spec defines the tool that renders those two data sources into a **single-file HTML report** users open in their browser to explore a run.

The report is the "money-shot" of a canaryone run — it's what a user shares on Slack, attaches to a PR, or screenshots for Twitter. It has to be readable without instructions.

## 2. Non-goals

- Live-updating during a run (that's LiveProgress in the TUI — separate surface).
- Server-side rendering / hosted view.
- Cross-run comparison / trend view (v0.1).
- Editing / annotating from the report (read-only view).
- Framework dependencies (React, Vue, Svelte, etc.) — see §5.

## 3. Invariants

1. **Read-only from the data sources.** The report generator never writes to SQLite or JSONL. It only reads.
2. **Single self-contained HTML file.** Output is `.c1/runs/<runId>/report/index.html`. Embedded CSS + JS. Zero external HTTP requests when opened offline. This is the whole point — it has to work when a user emails the file to a colleague.
3. **Regenerable.** `c1 runs report <runId>` regenerates the file from the current SQLite + JSONL state without touching anything else.
4. **Deterministic.** Same inputs → identical bytes (modulo timestamps in the header). Makes it diffable in git if someone wants to check that in.
5. **Sub-1 MB output.** For an 18-session run, the HTML should be well under 1 MB. Larger inputs paginate the session drilldown; the top-level heatmap + summary is always full.

---

## 4. Data contract

The report reads from two places and NOTHING ELSE:

### 4.1 SQLite: `<targetDir>/.c1/db.sqlite`

Schema documented in [`src/db/sqlite.ts`](./src/db/sqlite.ts). Tables + columns Bhaskar's report uses:

**`runs`**
- `id` (PK), `started_at`, `finished_at`, `status`, `target_dir`, `meta_json`

**`sessions`**
- `id` (PK), `run_id` (FK), `task_id`, `task_file`, `model_slug`, `destination_slug`, `router`, `repeat_ix`, `status`, `started_at`, `finished_at`, `cost_usd`, `verify_exit_code`, `verify_stdout_tail`, `verify_stderr_tail`, `failure_class`, `worktree_path`, `proxy_port`

**`steps`**
- `id` (PK), `session_id` (FK), `step_ix`, `started_at`, `finished_at`, `http_status`, `inbound_shape`, `path`, `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `translation_notes`, `traffic_log_offset`, `traffic_log_length`, `failure_class`

**`tasks_meta`**
- `task_id` (PK), `file`, `summary`, `uses_llm`

**`classifier_tags`** *(schema v2, shipped 2026-07-29 — one row per dimension, 8 rows per session)*
- `id` (PK), `session_id` (FK → sessions.id), `dimension`, `value`, `confidence`, `generated_at`, `model`, `classifier_id` (= `canaryone_judge_v1_local`), `classifier_version` (= `2026-07-29-haiku-r5-local`)
- Dimensions written per session:
  - `outcome` — string enum `'success' | 'failure' | 'uncertain'` (mirrors `verify_exit_code`: 0 → success, non-zero → failure, null → uncertain)
  - `trajectory_score` — integer 0-100 (composite = action + grounding + verification + efficiency)
  - `action_score` — integer 0-25 (computed from JSONL, `confidence=1.0`)
  - `grounding_score` — integer 0-25 (LLM-judged)
  - `verification_score` — integer 0-25 (LLM-judged)
  - `efficiency_score` — integer 0-25 (computed from JSONL, `confidence=1.0`)
  - `judge_reasoning` — one-sentence string
  - `trajectory_reasoning` — one-sentence string
- To pivot to one-row-per-session for the lane table / heatmap, `GROUP BY session_id` with `MAX(CASE WHEN dimension='X' THEN value END)` per dimension. See `src/runner/print-summary.ts` for a working example.

### 4.2 JSONL: `<targetDir>/.c1/runs/<runId>/traffic.jsonl`

Append-only newline-delimited JSON. One record per line. Shape documented in [`src/runner/traffic-log.ts`](./src/runner/traffic-log.ts) — `TrafficRecord`.

**Kinds Bhaskar cares about:**
- `session-start` / `session-end` — run boundary markers (skip these)
- `request` — carries `session_id`, `step_id`, `step_ix`, `body` (the request JSON), `lane`, `inbound_shape`
- `response` — carries same identifiers + `body` (the response JSON), `usage`, `latency_ms`, `cost_usd`, `http_status`
- `chunk` — SSE chunk (D5+; safe to ignore for now, none in current runs)
- `error` — a failed request; carries `error` string + timing

For the report, iterate the JSONL once and build a map: `sessionId → { requests: [], responses: [] }`. That's enough for the drilldown.

### 4.3 `meta.json` (optional but useful)

`<targetDir>/.c1/runs/<runId>/meta.json` — snapshot of the run config at start. Used for the report header. Same shape as `RunMeta` in `traffic-log.ts`.

### 4.4 Prior art to crib from

`src/runner/print-summary.ts` already implements the roll-up + best-value / cheapest-raw computation for the ASCII summary. Bhaskar's HTML lane-table + aggregate card should mirror this logic (per-lane pass rate, spend, avg trajectory, raw + weighted $/pass, ⚠ badge on traj < 50). Do NOT re-derive independently — read the file and translate.

The formatters live in `src/lib/fmt.ts` (`fmtDollars`, `fmtDuration`). Import + use them so the HTML matches what the terminal prints.

### 4.5 Traj⚠ interpretation nuance (important for tooltip copy)

The `⚠` glyph on `trajectory_score < 50` currently means two different things depending on the workload:

- **Flavor 1 (real narration):** multi-turn agent that had tool_calls available but passed the test by narrating instead of grounding. Weighted $/pass is a real "cheap-but-wrong" signal. This is what SPEC 1 §11.2 designed for.
- **Flavor 2 (workload-shape artifact):** stateless classifier / structured-output test with zero tool_calls. `action_score=0` + `verification_score=0` are structurally forced — the test can't score high on those dimensions no matter which model runs it. Every provider scores ~47 identically. Weighted $/pass is not a quality signal in this case.

For the tooltip / drilldown copy, DO NOT hardcode "narrated" as the explanation for traj < 50. Suggested pattern:
- If `SUM(tool_calls across all steps in session) == 0` for every session in the run → surface a banner: *"This workload didn't invoke tool_calls. Trajectory scores reflect workload shape, not model quality — compare on raw $/pass and latency instead."*
- Otherwise render the standard "narrated" warning per the SPEC.

The count of tool_calls per session can be derived from `steps` via the JSONL byte-range (see [`src/judge/subscores.ts`](./src/judge/subscores.ts) `computeEfficiencyScore` for how). For a first cut, `session.step_count > 1 && grounding_score < 15 && verification_score < 15` is a good heuristic for Flavor 1.

---

## 5. Tech choices (mandated)

- **No framework.** Vanilla HTML + inline CSS + inline JS. Reason: reports need to open offline, attach to emails, work when opened via `file://`, and survive a decade. React/Next/Vue add fragility.
- **CSS variables + Tailwind-inspired utility class names** are fine — but write them out explicitly, don't ship Tailwind.
- **Charts:** if you want inline charts (sparklines etc.), use SVG hand-written or **inline Chart.js** (~100 KB minified — embed the whole source into `<script>` tags, do NOT `<script src="cdn...">`). Anything requiring a network fetch is banned.
- **Interactivity:** vanilla JS. Expand/collapse via `<details>`/`<summary>` where possible (native, zero JS). Sortable table via a tiny hand-written listener (~30 lines).
- **Fonts:** system stack. `-apple-system, BlinkMacSystemFont, "Segoe UI", ...`. Monospace: `ui-monospace, "SF Mono", Menlo, monospace`.
- **Light theme, default.** White background, black ink, blue accent — matches the aesthetic of tools users share to Slack / PRs / Twitter. Reference: `~/Documents/GitHub/product0/reports/oc-deepseek-2026-07-17/index.html`. Terminal (canaryone TUI) is the dark surface; the report is the presentable surface. No dark-mode toggle for v0.

---

## 6. File structure

File layout (phase 0 ships lines marked `[P0]`; phase 1 fills in `[P1]`):

```
src/report/
  generate.ts             [P0] entry point: reads db + jsonl, emits index.html.
                                Returns absolute path to the written file.
  data.ts                 [P0] SQLite read helpers + JSONL iterator + JSON body
                                enumerator (recursive key/type walker for Layer 3).
  template.ts             [P0] HTML shell (as a template literal): <head>, styles,
                                scripts, then slots for each section.
  styles.ts               [P0] embedded CSS (light theme, product0-style)
  scripts.ts              [P0] embedded JS: sort, expand, chip-filter dispatch,
                                Chart.js UMD (inlined verbatim — no CDN)
  sections/
    hero.ts               [P0] metadata block + "how we measure" primer
    inventory.ts          [P0] the §7.0 scaffold — Layers 1-4
    header.ts             [P1] leaderboard headline cards
    heatmap.ts            [P1] lanes × tasks heatmap
    lane-table.ts         [P1] sortable lane summary table
    session-list.ts       [P1] collapsible per-session drilldown
    aggregate.ts          [P1] cheapest/most-expensive/spread stats
tests/
  report.test.mjs         [P1] snapshot test against tests/fixtures/canned-run-1
```

Phase 0 sections that don't exist yet (leaderboard, heatmap, lane-table, session-list, aggregate) render as `<section class="stub"><h2><span class="sec-num">NN</span>Title</h2><p class="muted">Phase 1: TODO</p></section>` placeholders so the page structure is complete and the section numbering stays consistent.

Bhaskar owns everything under `src/report/sections/` (phase 1). Rupul owns `src/report/{generate,data,template,styles,scripts}.ts` + `src/report/sections/inventory.ts` (phase 0). If Bhaskar needs a new column in SQLite or a new record shape in JSONL, he files a request; Rupul makes the change on the runner side.

**Phase 0 CLI integration** (Rupul, this session):
- Orchestrator auto-generates the report AFTER `judgePool.drain()` and BEFORE emitting `run:complete`. Emits a `report:generating` bus event on start, `report:generated` (with the file path) on finish. Gated on `spec.generateReport !== false` (default true).
- `RunSpec` gains `generateReport?: boolean` (default true) and `reportPath` accumulates on the store via the `report:generated` event.
- LiveProgress "Run complete" screen keybindings:
  - `enter` → open the report in the default browser (was: open run dir)
  - `o` → open the run dir in the file manager (unchanged)
  - `r` → run again (unchanged)
  - `q` → quit (unchanged)
  Footer text updated accordingly.
- New CLI subcommand `c1 runs report <runId>` — regenerates + opens the report. Stub added phase 0; body calls `generate(runId, configDir)` from `src/report/generate.ts`.

The `generate(runId, configDir)` entry point returns `Promise<string>` — the absolute path to the written HTML. Bhaskar's phase 1 replaces the section stubs but keeps this signature stable.

---

## 7. Visual layout — ASCII wireframes

Light theme (see §8). Green = pass, red = fail, amber = uncertain / warn, gray = queued/skipped/muted. Cost shown at scale-appropriate precision.

Sections are numbered `00`, `01`, `02`, ... — one `<h2>` per section with a monospace `sec-num` prefix. Every non-trivial section carries an inline `<details class="explain">` "How to read this" block, open by default on first render.

### 7.0 Data inventory (scaffold — phase 0, will be removed)

**Purpose:** before the real sections are designed, this scaffold surfaces every field / log the runner records for this run. We look at it once, decide which fields carry signal, and translate those observations into the real sections in a later pass. It's an editor's tool, not a viewer's tool. Keep it as `section 00`, always collapsed by default, so real users don't see it as the money-shot.

Layout: one `<section id="s0">` with three nested `<details>` blocks, one per layer.

**Layer 1 — SQLite schema + row counts.** Every table in `.c1/db.sqlite`, plus `traffic.jsonl` as a virtual "table":

```
▶ Layer 1 · SQLite tables (5) + traffic.jsonl (1 file)

   runs                    (1 row)         columns: id, started_at, finished_at, status,
                                                    target_dir, meta_json
   sessions                (18 rows)       columns: id, run_id, task_id, task_file,
                                                    model_slug, destination_slug, router,
                                                    repeat_ix, status, started_at,
                                                    finished_at, cost_usd, verify_exit_code,
                                                    verify_stdout_tail, verify_stderr_tail,
                                                    failure_class, worktree_path, proxy_port
   steps                   (144 rows)      columns: id, session_id, step_ix, ...
   classifier_tags         (144 rows)      columns: id, session_id, dimension, value,
                                                    confidence, generated_at, model,
                                                    classifier_id, classifier_version
   tasks_meta              (2 rows)        columns: task_id, file, summary, uses_llm

   traffic.jsonl           (232 records)   kinds: request=115, response=115,
                                                    session-start=1, session-end=1
```

**Layer 2 — value distributions per column.** For each column, one row showing what values actually appear in this run. This is what makes the scaffold useful:

- **Numeric** (`cost_usd`, `latency_ms`, `input_tokens`, `output_tokens`): `min · max · avg · non-null count`
- **Enum-like** (`status`, `router`, `model_slug`, `destination_slug`, `dimension`): top-N values with counts, e.g. `openrouter=18`. When a column has only one distinct value, display it **dimmed** — flags "dead field for this run, not useful in a comparison view."
- **Free text** (reasoning strings, `verify_stdout_tail`, `verify_stderr_tail`): row count, avg length, first ~200 chars of the longest sample
- **Timestamps** (`started_at`, `finished_at`, `generated_at`): earliest → latest, total span
- **IDs / UUIDs**: unique count only (values themselves aren't useful)

Rendered as one dense `<table>` per SQLite table, columns `[column · type · distribution · sample]`.

**Layer 3 — JSON body inspector.** The `body` field in `traffic.jsonl` records and the `meta_json` field in `runs` are JSON blobs where the actual content lives (model, messages, choices, usage, tool_calls). Enumerate keys recursively for these:

```
▶ Layer 3 · JSON body shapes

   traffic.jsonl · kind=request · body
     .model                     string   "z-ai/glm-5.2"  (constant across 115 requests)
     .messages                  array    length 1..12 (avg 4.2)
       .messages[].role         enum     user=460, assistant=... tool=...
       .messages[].content      string   avg 620 chars, max 8400
       .messages[].tool_calls   array    present in N/460 messages
     .max_tokens                number   min 100, max 4000
     .stream                    boolean  false (constant)
     .provider                  object   present in 115 requests, { order: [providerTag] }

   traffic.jsonl · kind=response · body
     .id                        string   115 unique
     .model                     string   "z-ai/glm-5.2" (constant, matches request)
     .choices                   array    length 1 (constant)
       .choices[].message.content       string   avg 220 chars
       .choices[].message.tool_calls    array    present in N/115 (0..3 calls each)
       .choices[].finish_reason         enum     stop=X, tool_calls=Y, length=Z
     .usage                     object   { prompt_tokens, completion_tokens, total_tokens }

   runs.meta_json
     .runId, .startedAt, .targetDir, .configDir, .parallelism, .repeats
     .lanes[]  ← model, destination, router
     .tasks[]  ← id, file
```

Rendered as a recursive tree. Each nested field shows its type + a one-line distribution (constant / range / enum). Blob values not shown here — cross-linked to the session drilldown (§7.4) for full payloads.

**Layer 4 — Candidate computed metrics.** Editorial, not from schema. Pre-populated with metrics we know we want; a `<!-- TODO -->` list of possible additions. Renders as two adjacent columns:

```
Ready today (already computed in src/runner/print-summary.ts)          Possible additions (rip out or keep)
──────────────────────────────────────────────────────────────         ────────────────────────────────────
Total spend:  $0.0429                                                  Per-repeat variance (cost, latency, traj)
Elapsed:      9m04s                                                    p50/p95 latency per lane
Pass rate:    18/18 (100%)                                             Cache utilization (if OR returns it)
Best value:   openrouter:baseten/fp4  ($0.0128 weighted per pass)      Trajectory sub-score histograms
Cheapest raw: openrouter:baseten/fp4  ($0.006121 per pass)             Tool-call count per session
Traj range:   47–50 across all sessions (⚠ workload doesn't            Refusal rate (final-content=empty)
              exercise traj — see §4.5)                                Failure taxonomy (auth / rate / 5xx)
Per-lane:     baseten/fp4 vs phala rollup (see below)                  Judge disagreement rate per lane
```

The point of this panel: after we've looked at the run, we know what's worth promoting into a real numbered section. The scaffold's job is done once we've decided.

### 7.1 Header (with "how we measure" primer)

The hero has TWO parts:

**Part A: metadata block** — the ASCII wireframe below.
**Part B: "how we measure" primer** — a bordered callout that names the primary metric (**weighted $/pass**), displays the formula, and explains the semantics in one paragraph. Reference: product0 report's `.metric-primer` block. This sets the frame BEFORE the leaderboard renders, so a cold viewer doesn't have to reverse-engineer the columns.

```
┌─ How we measure ─────────────────────────────────────────────────────────────┐
│ Every ranking in this report is denominated in **weighted $/pass** — the     │
│ dollars you'd spend to get one grounded pass on your workload, penalizing    │
│ passes that succeeded by narration instead of real work.                     │
│                                                                              │
│   weighted $/pass  =  $/pass  ÷  (trajectory_score / 100)                    │
│                                                                              │
│ Raw $/pass counts every passing exit-code as equal. Trajectory score         │
│ (0-100) is a canaryone-judge composite of Action + Grounding + Verification  │
│ + Efficiency — how the model actually got to the answer. Weighted $/pass     │
│ collapses "cheap" and "actually good" into one number so there's a single    │
│ best per run, not a Pareto curve.                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  canaryone · Run report                                                     │
│                                                                             │
│  Run              3d5394a2-6911-4cc1-be98-b905f604e08b                     │
│  Started          2026-07-29 15:42:07 UTC                                   │
│  Duration         38s     Wall clock                                        │
│  Target           /Users/rupul/Documents/GitHub/canaryone/demo              │
│  Model(s)         moonshotai/kimi-k3, google/gemini-2.5-flash               │
│  Lanes            21 destinations (14 OR routes, 4 direct APIs, 3 preview)  │
│  Sessions         21 × 2 tasks × 3 repeats = 126 total                      │
│  Pass rate        118/126 (93.7%)                                           │
│  Total spend      $0.0324  (2853 in / 1805 out tokens across all sessions)  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Heatmap — the money-shot

```
        Weighted $/pass = $/pass ÷ (trajectory_score / 100)
        Cells colored by weighted $/pass (green = cheap, red = expensive)
        ─────────────────────────────────────────────────────────────────
                                t01       t02       Weighted $/pass  ▼
   direct:nebius              $2.1e-6   $3.4e-6   $2.99e-6  (traj 92) ← cheapest legit
   openrouter:google-flash    $2.4e-6   $5.1e-6   $4.05e-6  (traj 91)
   openrouter:moonshotai      $2.8e-5   $2.9e-5   $3.22e-5  (traj 88)
   direct:groq                $8.0e-7   $9.0e-7   $2.35e-6  (traj 34) ⚠ narrated
   openrouter:cerebras        $5.5e-5   $9.5e-5   $8.20e-5  (traj 91)
```

Cell color: **weighted** $/pass gradient (green = low weighted cost, red = high). Cell text shows raw `$/pass` for that (lane, task). Trajectory score renders next to each row's weighted total, with `⚠` badge when score < 50.

Two toggles at the top: `[weighted]` (default) or `[raw]` — switches which value drives cell color. Users who want to see raw cheapness (ignoring trajectory quality) can flip to raw.

Failed cells: red background with `✗`. Uncertain (from judge): amber.

### 7.3 Lane table — sortable

```
Lane                     Model      Router  Pass  $/pass    Traj   Weighted     p50 lat.
────────────────────────────────────────────────────────────────────────────────────────
● direct:nebius          kimi-k3    direct  6/6   $2.75e-6   92    $2.99e-6     3200 ms
● openrouter:moonshotai  kimi-k3    OR      6/6   $2.83e-5   88    $3.22e-5     6760 ms
● direct:moonshot-intl   kimi-k3    direct  6/6   $2.10e-6   85    $2.47e-6     1240 ms
● direct:groq            kimi-k3    direct  6/6   $8.00e-7   34 ⚠  $2.35e-6      520 ms
● openrouter:cerebras    kimi-k3    OR      6/6   $5.50e-5   91    $6.04e-5      520 ms
```

Columns clickable = sort. Default sort: Weighted $/pass ascending. Lane-name click = jump to session drilldown filtered by that lane.

**Traj column** shows the composite 0-100 score. Hover shows the 4 sub-scores (Action, Grounding, Verification, Efficiency, each 0-25). Score < 50 gets a `⚠` badge.

Sortable columns:
- Lane (alphabetic)
- Pass rate
- Raw $/pass
- **Traj** (highest quality first)
- **Weighted $/pass** (default, ascending)
- p50 latency

### 7.4 Session drilldown (collapsible)

```
▶ Session b2272506… · direct:moonshot-intl · t01 · repeat 0                  ✓ passed · $2.1e-6
   Details ────────────────────────────────────────────────────────────────
   Task file          demo/tests/agent.test.js
   Verify exit code   0
   Duration           1240 ms
   Steps              1
   Cost               $0.0000021
   Judge outcome      success (0.92)   ← always mirrors verify_exit_code
                                        (0→success, non-zero→failure, null→uncertain)
                                        Enum: 'success' | 'failure' | 'uncertain'
   Judge reasoning    Model returned "pong" as requested; test asserted non-empty…
   
   Trajectory         85/100  (confidence 0.86)
     Action           25/25   Tool call fired on the one applicable turn
     Grounding        22/25   Final response directly cites the retrieved timestamps
     Verification    13/25   Agent did not re-read modified files
     Efficiency       25/25   No redundant tool calls; every call moved forward
   Traj reasoning     Agent chained log-query → RAG-lookup → answer, cited
                      specific timestamps from log excerpt. Missed self-verification
                      step but result is grounded in retrieved evidence.
   
   Step 1 · POST /v1/chat/completions ─────────────────────────────────────
   
   ▶ Request (JSON)
        [click to expand — model, messages, max_tokens]
   
   ▶ Response (JSON, 200)
        model: moonshotai/kimi-k3
        usage: { prompt: 72, completion: 3 }
        content: "pong"
   
   ▶ stdout tail
        ✔ echo returns a non-empty string
        ℹ pass 1  ℹ fail 0
```

Each session collapsed by default. Filter/search by lane, task, outcome (pass/fail).

### 7.5 Aggregate stats card

```
┌────────────────── Cost analysis ──────────────────────────────────┐
│                                                                    │
│  Best value (weighted $/pass)                                     │
│    direct:moonshot-intl    $2.47e-6 per grounded pass  (traj 85)  │
│                                                                    │
│  Cheapest raw ($/pass)                                            │
│    direct:groq             $8.00e-7 per pass          (traj 34 ⚠) │
│    ⚠ Lower quality trajectory — see Weighted $/pass for real cost │
│                                                                    │
│  Most expensive weighted                                           │
│    openrouter:cerebras     $6.04e-5 per grounded pass  (traj 91)  │
│                                                                    │
│  Spread (weighted)         24.4×                                   │
│    (best-value → most-expensive on identical work)                 │
│                                                                    │
│  Direct providers                                                  │
│    moonshot-intl, nebius, groq                                    │
│    Best direct beats best OR route by 8% (weighted)                │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

The Groq call-out is the tweet money-shot: cheapest by raw metric, but a 34/100 trajectory score means the passing test isn't reflecting real work. This is the metric OR's tool can't compute.

---

## 8. Color palette

Light theme. Palette adapted from `~/Documents/GitHub/product0/reports/oc-deepseek-2026-07-17/index.html` — same visual vocabulary so a viewer moving between the two reports feels one continuous product family.

```
--bg           #ffffff    /* page background */
--panel        #fafafa    /* card / section background */
--ink          #1a1a1a    /* body text, headings */
--muted        #6b7280    /* labels, secondary text, section numbers */
--line         #e5e7eb    /* borders, dividers */
--line-strong  #d1d5db    /* stronger borders (row separators) */

--accent       #2563eb    /* blue — links, primary highlight */

/* Status (used by outcome/cell backgrounds AND the "safe/marginal/regression" family) */
--winner       #16a34a    /* green ink — winner rows */
--winner-bg    #dcfce7    /* winner row background */
--winner-ink   #14532d
--safe         #16a34a    /* pass, "grounded" */
--safe-bg      #dcfce7
--marginal     #ca8a04    /* amber — uncertain, "narrated" warning */
--marginal-bg  #fef9c3
--regression   #dc2626    /* red — failed, unreachable */
--regression-bg #fee2e2
--unusable-bg  #f3f4f6    /* gray — skipped, no-data */
--unusable-ink #6b7280
--unreachable-bg #fef2f2  /* rose — 0% pass rate */
--unreachable-ink #991b1b

/* Router / quantization badges (product0 pattern — reusable for canaryone's router column) */
--router-openrouter #22d3ee   /* cyan */
--router-direct     #7c3aed   /* violet */
--router-vercel     #0891b2
--router-cloudflare #f97316

/* Family colors — carry over from TUI so the same model reads the same in both surfaces */
--family-anthropic #D97757
--family-openai    #a855f7
--family-google    #4ade80
--family-deepseek  #00B7B5
--family-moonshot  #e879f9
--family-other     #64748b
```

Typography:
- Base 14 px / 1.5 line-height (product0 convention)
- Headings 15 px / 20 px / 28 px (h3/h2/h1), weight 600, letter-spacing -0.01em
- `font-variant-numeric: tabular-nums` on any cell that shows numbers — non-negotiable, tables must align
- Monospace stack: `"SF Mono", ui-monospace, Consolas, monospace` at 12.5 px for cost, model slugs, code blocks

### 8.1 Row shading conventions (from product0)

For rows in the leaderboard / lane table:

- Winner row (best weighted $/pass among passing lanes): `background: var(--winner-bg)`
- 0-pass lane: `background: var(--unreachable-bg)` with muted ink
- Rows with only computed sub-scores + judge_ok=false: `background: var(--unusable-bg)` — "judge failed, treat with skepticism"
- All other rows: default `--bg`

---

## 9. Charts (minimum viable)

For v0, no external chart lib. Just:

- **Heatmap** — HTML `<table>` with cell backgrounds computed from the log10 of the cost value bucketed into 8 gradient colors.
- **Bar sparklines in the lane table** — inline `<svg width="80" height="14">` per row, showing p50/p90 latency or cost distribution across the 3 repeats for that lane. Tiny, no lib.

If we later want fancier charts (histograms, scatter plots), add Chart.js inlined. Deferred.

---

## 10. Data-fetching implementation notes

### 10.1 SQLite reads

`node:sqlite` (Node 22+ stable). Bhaskar's `src/report/data.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';

export function loadRun(runId: string, dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  const sessions = db.prepare('SELECT * FROM sessions WHERE run_id = ? ORDER BY started_at').all(runId);
  const stepsBySession = new Map();
  const steps = db.prepare(`
    SELECT s.* FROM steps s JOIN sessions ss ON s.session_id = ss.id WHERE ss.run_id = ?
  `).all(runId);
  for (const s of steps) {
    (stepsBySession.get(s.session_id) ?? stepsBySession.set(s.session_id, []).get(s.session_id)).push(s);
  }
  const tags = db.prepare(`
    SELECT c.session_id, c.dimension, c.value, c.confidence, c.classifier_id, c.classifier_version
    FROM classifier_tags c
    JOIN sessions ss ON c.session_id = ss.id
    WHERE ss.run_id = ?
  `).all(runId);
  db.close();
  return { run, sessions, stepsBySession, tags };
}
```

Add `readOnly: true` and `PRAGMA query_only = ON;` after open — belt + suspenders.

### 10.2 JSONL streaming

Read via `node:fs` `createReadStream` + a line splitter. For 128 KB runs (D2's current fixture) you can just `readFileSync` and split by `\n`. For future large runs, stream:

```ts
async function* iterRecords(jsonlPath: string) {
  const raw = await fs.readFile(jsonlPath, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip malformed */ }
  }
}
```

Match to sessions by `record.session_id`.

### 10.3 Byte-range reads (optional, for large bodies)

If a session's response body is huge (e.g. 100 KB), don't inline the full text — inline a preview (~2 KB) with a "load full body" button that reads a byte range from `traffic.jsonl` via `fetch(...)` — WAIT, the file:// setup doesn't allow XHR. So we HAVE to inline everything.

**Consequence:** the report inlines every request + response body up to a per-body cap of 8 KB, then truncates with a "(N KB truncated)" marker. Session listing is paginated in the HTML (100 sessions per page).

---

## 11. Testing

- **Snapshot test:** `tests/report.test.mjs` — generates a report against a canned run (checked in under `tests/fixtures/canned-run-1/`), asserts key strings appear in the output ("Run report", cheapest lane, session count). Not a byte-for-byte snapshot; content-check.
- **Visual test:** open the generated report locally, screenshot, share with Rupul for a quick review. Not automated for v0.

## 12. Exit criterion

### Phase 0 (this conversation — Rupul, 2026-07-29)

Ships the plumbing + the scaffold, before the "real" sections are designed:

- `src/report/generate.ts` writes a self-contained `.c1/runs/<runId>/report/index.html` when called with `(runId, configDir)`.
- Report includes: hero (metadata + "how we measure" primer, §7.1), and the `00 Data inventory` scaffold (§7.0) with all four layers. Real sections (leaderboard, lane table, heatmap, session drilldown, aggregate) are stubbed as `TODO` placeholders — they render in phase 1 (Bhaskar).
- Orchestrator auto-generates the file after `judgePool.drain()`, before emitting `run:complete`. Console/subtitle shows `generating report…` during the write (~100-500 ms).
- LiveProgress "Run complete" screen has `enter` opening the report in the default browser (was: `enter` opens run dir; now `o` alone opens the dir; `v` also opens the report — see §6 "CLI integration").
- Opens cleanly via `file://` in Chrome, Safari, Firefox. Zero console errors, zero network requests.

### Phase 1 (Bhaskar's PR)

- Real numbered sections implemented (leaderboard, lane table, heatmap, session drilldown, aggregate).
- Scaffold `00 Data inventory` collapsed by default; can be removed once real sections cover its role.
- `tests/report.test.mjs` snapshot test passes.
- File under 1 MB for a 24-session run.
- Graceful degradation for runs without judge tags (per §4.5 heuristic).

## 13. Provenance + hand-off

- Written by Rupul in session `c1-bld2807-2`, 2026-07-29.
- Revised 2026-07-29 (session `c1-bld2907-judge`) after SPEC 1 Part B (judge) landed on main. Added §7.0 (data inventory scaffold), §4.4 (prior-art pointer), §4.5 (traj⚠ interpretation), phase-0 exit criterion.
- **Visual reference:** `~/Documents/GitHub/product0/reports/oc-deepseek-2026-07-17/index.html` — a shipped, polished report that already implements the "how we measure" primer, numbered sections with inline explainers, headline card row, chip filters, and From/To decision matrix. When Bhaskar starts on phase 1, this is the visual language to match.
- Phase 0 lands in this session (auto-gen + LiveProgress wire + hero + scaffold). Phase 1 delivered to Bhaskar via `git pull main` — read this doc + open the phase 0 output, then start on the real numbered sections under `src/report/sections/`.
- Any schema questions → ping Rupul; runner changes are Rupul-owned.
- CLI: `c1 runs report <runId>` regenerates the report post-hoc. Phase 0 wires the internal call from the orchestrator; the CLI subcommand ships alongside.

---

## 14. Nice-to-have (skip if time-constrained)

- Copy-to-clipboard buttons on session IDs / URLs
- "Share this report" — a fixed-bottom bar with the run path so users know where the HTML lives
- Keyboard shortcuts (`j`/`k` to move between sessions, `/` to search)
- Print stylesheet for PDF export
- CSV export of the lane table

None of these block the tweet. Ship the core, iterate later.
