# Kickoff prompt — HTML report (Bhaskar)

**How to use this file:** open a fresh Claude Code session in your terminal, paste everything from `───` to `───` below into the first message, then step aside. Read the SPEC yourself while Claude works (`c1-report-29july-SPEC.md`).

---

You're picking up SPEC 2 of canaryone — an offline HTML report generator that
renders a canaryone run into a single self-contained HTML file.

STATUS AS OF 2026-07-29: the runner (SPEC 1 Part B — judge) shipped on main
at commit 81f4c8b. Every `pnpm test:runner` invocation now writes 8
classifier_tags rows per session (outcome + trajectory_score + 4 sub-scores +
2 reasoning strings). Part A (multi-router) is still pending but doesn't
change your data contract — sessions just have `router='openrouter'` for now.

You own the report end-to-end. Rupul owns everything else.

Read the spec IN FULL before writing code:
  https://github.com/rupulsafaya/canaryone/blob/main/c1-report-29july-SPEC.md

Everything below is context to help you execute it.

────────────────────────────────────────────────────────────────────────────
WHAT YOU OWN
────────────────────────────────────────────────────────────────────────────

- Everything under `src/report/` (you create this directory)
- `tests/report.test.mjs`

WHAT YOU DO NOT TOUCH (Rupul owns these):
- `src/proxy/` — the lane proxy
- `src/runner/` — the run engine
- `src/state/` — the zustand store
- `src/db/sqlite.ts` — the schema (READ from it; if you need a new column, file
  an issue instead of editing)
- `src/scan/` — repo scanning + methodology
- Any of the TUI screens under `src/screens/`

If you touch something outside `src/report/`, stop and ping Rupul first.

────────────────────────────────────────────────────────────────────────────
STEP 1 — CLONE AND SET UP THE REPO
────────────────────────────────────────────────────────────────────────────

git clone https://github.com/rupulsafaya/canaryone.git
cd canaryone
git config user.email <your-personal-email>
git checkout -b bhaskar/html-report
pnpm install

Node version required: >= 22. Verify with `node --version`.

KNOWN INSTALL HAZARDS — hit these once and forget:

1. `pnpm approve-builds` will prompt for node-pty. Approve it.

2. On macOS ARM (Apple Silicon), the node-pty prebuild ships non-executable:
     chmod +x node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
   Only needed if `pnpm test:tui` errors with a spawn-helper permission issue.

3. `~/.c1/.env` must exist with `OPENROUTER_API_KEY=sk-or-v1-...`. If you don't
   have one, get from https://openrouter.ai/keys. ~$5 credit is plenty.

Verify install:
  npx tsc --noEmit       # should exit 0
  pnpm test:tui          # 13 pty scenarios, ~1 min. Should all pass.
  pnpm test:judge        # judge trajectory + subscores unit tests. Fast.
  pnpm test:runner       # integration test (real OR call). ~$0.00002. Should
                         # print outcome=success + trajectory=50 near the end.

────────────────────────────────────────────────────────────────────────────
STEP 2 — GENERATE REAL RUN DATA TO BUILD AGAINST
────────────────────────────────────────────────────────────────────────────

The report reads from `.c1/db.sqlite` + `.c1/runs/<runId>/traffic.jsonl`. You
need real data before you can render anything. Two ways:

OPTION A (fastest — headless integration test):
  pnpm test:runner

  This writes to a fresh /tmp/c1-runner-<random>/ dir and prints the path at
  the end. Inside you'll find:
    .c1/db.sqlite                          — sessions, steps, classifier_tags
    .c1/runs/<runId>/traffic.jsonl         — request + response bodies
    .c1/runs/<runId>/meta.json             — run config snapshot
    .c1/runs/<runId>/sessions/<sessionId>.md

  As of 2026-07-29 (main), this fixture-run also writes 8 judge tags per
  session (outcome, trajectory_score, action/grounding/verification/
  efficiency_score, judge_reasoning, trajectory_reasoning). The echo fixture
  is single-turn so grounding + verification = 0 and trajectory_score = 50.
  That's fine — enough data to exercise your renderer's judge-column code
  paths. For a richer fixture with real multi-turn agent traffic, use
  OPTION B.

  Cost: ~$0.00002. Takes ~5 seconds.

  COPY that entire /tmp/c1-runner-<random>/.c1 dir into
  tests/fixtures/canned-run-1/.c1 so you have a stable reference:
    mkdir -p tests/fixtures/canned-run-1
    cp -r /tmp/c1-runner-<random>/.c1 tests/fixtures/canned-run-1/

OPTION B (bigger dataset — walk the TUI):
  pnpm dev -- --target $HOME/Documents/GitHub/canaryone/tests/fixtures/openai-sdk-echo

  Walk through: KeySetup → Onboarding (Enter to accept) → Summarize
  (Enter) → Methodology (Enter) → PickTasks (space to select both, Enter)
  → PickModels (space to select 2-3 cheap models like openai/gpt-4o-mini,
  google/gemini-2.5-flash, Enter) → PickDestinations (space per model,
  Enter) → Confirm (Enter). LiveProgress runs the actual sessions. Wait
  for "Run complete." Cost: ~$0.005-0.02.

  Data goes in tests/fixtures/openai-sdk-echo/.c1/. Copy into
  tests/fixtures/canned-run-2/ for reference.

Either option gets you ONE working run to render. For richer content — pass
rates < 100%, judge tags, etc. — pnpm test:runner is enough for now.

────────────────────────────────────────────────────────────────────────────
STEP 3 — INSPECT THE DATA CONTRACT
────────────────────────────────────────────────────────────────────────────

Before you write any renderer code, read these files end-to-end:

  src/db/sqlite.ts          — SQLite schema (RunRow, SessionRow, StepRow types).
                              Section between lines 30-90 has everything.
  src/runner/traffic-log.ts — JSONL record shape (TrafficRecord type at the top).
                              iterRecords() is the streaming helper you'll want.

Poke at your canned run with the SQLite CLI:

  DB=tests/fixtures/canned-run-1/.c1/db.sqlite

  # High-level table layout
  sqlite3 "$DB" '.tables'
  sqlite3 "$DB" '.schema classifier_tags'
  sqlite3 -column -header "$DB" 'SELECT * FROM sessions LIMIT 3;'

  # See the 8 judge dimensions written per session:
  sqlite3 -column -header "$DB" "SELECT dimension, value, confidence FROM classifier_tags LIMIT 20;"

  # Pivot to one-row-per-session (mirror what the lane table needs):
  sqlite3 -column -header "$DB" "
    SELECT substr(s.id,1,8) sess, s.destination_slug,
           MAX(CASE WHEN ct.dimension='outcome' THEN ct.value END) outcome,
           MAX(CASE WHEN ct.dimension='trajectory_score' THEN ct.value END) traj,
           MAX(CASE WHEN ct.dimension='action_score' THEN ct.value END) act,
           MAX(CASE WHEN ct.dimension='grounding_score' THEN ct.value END) grnd,
           MAX(CASE WHEN ct.dimension='verification_score' THEN ct.value END) vfy,
           MAX(CASE WHEN ct.dimension='efficiency_score' THEN ct.value END) eff
    FROM sessions s LEFT JOIN classifier_tags ct ON ct.session_id = s.id
    GROUP BY s.id;
  "

And the JSONL:

  head -3 tests/fixtures/canned-run-1/.c1/runs/*/traffic.jsonl | python3 -m json.tool

Also read src/runner/print-summary.ts end-to-end — it already implements
the roll-up + Best value / Cheapest raw computation you'll need to translate
into HTML. Do NOT re-derive from scratch.

At this point you know EXACTLY what data flows into your report. Do not
speculate about shapes — read the tables.

────────────────────────────────────────────────────────────────────────────
STEP 4 — IMPLEMENT SPEC 2
────────────────────────────────────────────────────────────────────────────

Read c1-report-29july-SPEC.md end to end. Note especially:

  §4  Data contract — WHERE to read, exactly which tables/columns/records
  §5  Tech choices — no framework, vanilla HTML + inline CSS + inline JS,
      works via file:// and offline, dark theme, system font stack
  §6  File structure — src/report/ layout is prescribed; follow it
  §7  ASCII wireframes for all sections (header, heatmap, lane table,
      session drilldown, aggregate)
  §8  Color palette (dark theme with CSS variables)
  §10 Data-fetching patterns (SQLite `readOnly: true`, JSONL streaming)
  §11 tests/report.test.mjs snapshot test
  §12 Exit criterion — this is the definition of done

Ordering suggestion:
  1. src/report/data.ts       — SQLite + JSONL read helpers (~1 hr)
  2. src/report/generate.ts   — orchestrator: reads data → passes to sections
                                → writes single HTML file
  3. src/report/styles.ts     — CSS as a template string (~30 min)
  4. src/report/scripts.ts    — vanilla JS for sort + expand
  5. src/report/sections/     — one file per section from §7:
                                  header.ts, heatmap.ts, lane-table.ts,
                                  session-list.ts, aggregate.ts
  6. tests/report.test.mjs    — snapshot test against canned-run-1

Rupul stubs the CLI: `c1 runs report <runId>` will call
  import('./report/generate').generate(runId, configDir)
so make sure that's your exported entry point. You don't wire the CLI
yourself — Rupul handles it.

────────────────────────────────────────────────────────────────────────────
STEP 5 — GRACEFUL DEGRADATION IS REQUIRED
────────────────────────────────────────────────────────────────────────────

SPEC 1 Part B (judge) already shipped on main 2026-07-29 — every fresh
run has judge tags. But two cases still hit the graceful-degradation path:

  1. Runs generated BEFORE the schema-v2 migration (older .c1/db.sqlite
     without classifier_id / classifier_version columns, and no judge tags).
  2. Runs where the judge worker failed for every session (network dead,
     OR_JUDGE_KEY unset) — sessions have status=complete but
     classifier_tags has zero rows for their session_ids, OR
     fallbackVerdict wrote outcome + action + efficiency but zero for
     grounding/verification/trajectory_score.

Your report MUST render cleanly in both cases. Behavior:

  - Trajectory-related columns simply hide when no traj tags exist for the run
  - Weighted $/pass column hides too (needs traj score to compute)
  - Report still renders header + heatmap (colored by raw $/pass) + lane
    table + session drilldown + a simplified aggregate card

For the traj⚠ tooltip copy: read c1-report-29july-SPEC.md §4.5. The ⚠ badge
means one of two different things depending on workload shape — the copy
must NOT hardcode "narrated" for tests that never emit tool_calls. See the
spec for the heuristic.

Test this against BOTH:
  - canned-run-1 from `pnpm test:runner` — WILL have judge tags (single-turn
    fixture, trajectory_score = 50, grounding + verification = 0)
  - canned-run-2 from a walk-the-TUI multi-turn agent run — will have richer
    trajectory scores (grounding + verification > 0)

────────────────────────────────────────────────────────────────────────────
STEP 6 — COMMIT + PR
────────────────────────────────────────────────────────────────────────────

You're on branch bhaskar/html-report. When your PR is ready:

  npx tsc --noEmit       # should exit 0
  pnpm test:tui          # regression — should still be 13/13
  pnpm test:judge        # regression — trajectory + subscores unit tests
  pnpm test:runner       # regression — outcome=success + 8 judge tags
  tests/report.test.mjs  # your new test — should pass

Commit with a descriptive message. Push to origin. Open PR against main.
Rupul reviews.

────────────────────────────────────────────────────────────────────────────
QUESTIONS
────────────────────────────────────────────────────────────────────────────

If you hit anything you can't resolve from the SPEC + source:
  - Post in Slack (Rupul is on)
  - Do NOT modify anything outside src/report/ or tests/report.test.mjs
    without explicit approval

Now: read the SPEC, walk through Steps 1-3 to get real data, then start
implementing.
