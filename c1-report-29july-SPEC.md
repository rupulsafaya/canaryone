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
- **Charts:** if you want inline charts (sparklines etc.), use SVG hand-written or a tiny lib inlined (Chart.js is ~100 KB, acceptable). Do NOT use anything that requires a network fetch.
- **Interactivity:** vanilla JS. Expand/collapse via `<details>`/`<summary>` where possible (native, zero JS). Sortable table via a tiny hand-written listener (~30 lines).
- **Fonts:** system stack. `-apple-system, BlinkMacSystemFont, "Segoe UI", ...`. Monospace: `ui-monospace, "SF Mono", Menlo, monospace`.
- **Dark theme, default.** No light-mode toggle for v0.

---

## 6. File structure

Bhaskar creates:

```
src/report/
  generate.ts         ← entry point: reads db + jsonl, emits index.html
  template.ts         ← the HTML shell (as a template literal)
  sections/
    header.ts         ← run metadata block
    heatmap.ts        ← lanes × tasks heatmap
    lane-table.ts     ← sortable lane summary table
    session-list.ts   ← collapsible per-session drilldown
    aggregate.ts      ← cheapest/most-expensive/spread stats
  styles.ts           ← the embedded CSS as a string
  scripts.ts          ← the embedded JS as a string (sort, expand)
  data.ts             ← SQLite read helpers + JSONL iterator
tests/
  report.test.mjs     ← generate against a known fixture run, snapshot the output
```

Bhaskar owns everything under `src/report/`. Rupul owns everything else. If Bhaskar needs a new column in SQLite or a new record shape in JSONL, he files a request; Rupul makes the change on the runner side.

**CLI integration** (Rupul wires this at the end of D3): `c1 runs report <runId>` (and auto-runs on run completion). Rupul stubs this and calls `import('./report/generate').generate(runId, configDir)` — Bhaskar just needs to export that function.

---

## 7. Visual layout — ASCII wireframes

Terminal-style dark theme. Green = pass, red = fail, amber = uncertain, gray = queued/skipped. Cost shown at scale-appropriate precision.

### 7.1 Header

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

Dark theme, terminal-aesthetic:

```
--bg-primary       #0a0a0f    /* page background */
--bg-secondary     #12121a    /* card / section background */
--bg-tertiary      #1a1a26    /* row hover, expanded state */
--border           #2a2a3a
--text-primary     #e4e4e7    /* headings, primary text */
--text-secondary   #a1a1aa    /* labels, secondary */
--text-muted       #52525b    /* de-emphasized */

--accent           #22d3ee    /* cyan — links, highlights */
--accent-hover     #67e8f9

/* Status */
--status-pass      #22c55e    /* green — passed sessions, "grounded" */
--status-fail      #ef4444    /* red — failed sessions */
--status-warn      #eab308    /* amber — uncertain, "narrated" */
--status-info      #3b82f6    /* blue — running, informational */
--status-muted     #71717a    /* gray — queued, skipped */

/* Heatmap gradient (cheap → expensive) */
--heat-1           #059669    /* darkest green (cheapest) */
--heat-2           #10b981
--heat-3           #34d399
--heat-4           #86efac
--heat-5           #fef3c7
--heat-6           #fdba74
--heat-7           #f97316
--heat-8           #ef4444    /* red (most expensive) */

/* Family colors — carry over from TUI */
--family-anthropic #D97757
--family-openai    #a855f7
--family-google    #4ade80
--family-deepseek  #00B7B5
--family-moonshot  #e879f9
--family-other     #94a3b8
```

Typography:
- Base 14 px / 20 px line-height
- Headings 16 px / 20 px / 24 px (h3/h2/h1)
- Monospace for cost, model slugs, code blocks

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

## 12. Exit criterion for Bhaskar's PR

- `tests/report.test.mjs` passes.
- Opening `.c1/runs/<runId>/report/index.html` in Chrome, Safari, and Firefox shows all sections without console errors.
- File is under 1 MB for a 24-session run.
- All sections render even when some data is missing (e.g. no `classifier_tags` for pre-judge runs — just hide the "trajectory quality" column gracefully).

## 13. Provenance + hand-off

- Written by Rupul in session `c1-bld2807-2`, 2026-07-29.
- Delivered to Bhaskar via `git pull main` — read this doc, ask questions in Slack, start on `src/report/`.
- Any schema questions → ping Rupul; runner changes are Rupul-owned.
- Rupul lands a stub CLI: `c1 runs report <runId>` calls `generate(runId, configDir)` — Bhaskar just needs to export that function from `src/report/generate.ts`.

---

## 14. Nice-to-have (skip if time-constrained)

- Copy-to-clipboard buttons on session IDs / URLs
- "Share this report" — a fixed-bottom bar with the run path so users know where the HTML lives
- Keyboard shortcuts (`j`/`k` to move between sessions, `/` to search)
- Print stylesheet for PDF export
- CSV export of the lane table

None of these block the tweet. Ship the core, iterate later.
