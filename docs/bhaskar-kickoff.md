# Kickoff prompt — HTML report (Bhaskar)

**How to use this file:** open a fresh Claude Code session in your terminal, paste everything from `───` to `───` below into the first message, then step aside. Read the SPEC yourself while Claude works (`c1-report-29july-SPEC.md`).

---

You're picking up the canaryone HTML report. **The scaffolding, plumbing, and phase-1 report are already shipped on `main` as of 2026-07-29 (commits `b2aae16` → `aa7dd01`).** Your job is to iterate on top of what's there: polish the visual language, add the sections we deferred, and make this something a stranger can screenshot and share.

Read the spec IN FULL before writing code:
  https://github.com/rupulsafaya/canaryone/blob/main/c1-report-29july-SPEC.md

Everything below is context to help you take it from "usable" to "sharable."

────────────────────────────────────────────────────────────────────────────
CURRENT STATE — WHAT'S ALREADY BUILT
────────────────────────────────────────────────────────────────────────────

Files under `src/report/` (all shipped, all working):

  data.ts              SQLite + JSONL readers, JSON body profiler,
                       laneRollup / rankLanes / percentile shared helpers.
  generate.ts          Entry point. `generate(runId, configDir): Promise<string>`
                       returns absolute path to the written HTML.
  template.ts          HTML shell + tab structure. Two tabs: "Report"
                       (default) + "Data inventory · scaffold".
  styles.ts            Embedded CSS. Light theme adapted from
                       ~/Documents/GitHub/product0/reports/oc-deepseek-2026-07-17.
  scripts.ts           Vanilla JS: tab switch, sortable-column dispatch,
                       heatmap raw/weighted toggle. No CDN, no framework.
  sections/hero.ts     Title + metadata table + two collapsible primers:
                       "What happened in this run" (onboarding) and
                       "How we measure" (metric semantics).
  sections/inventory.ts  §00 Data inventory scaffold — 4 layers.
                       Lives under the "Data inventory" tab. Rip out or
                       repurpose once real sections cover its role.
  sections/leaderboard.ts  §01 — 4 headline cards (Best value / Cheapest
                       raw / Pass rate / Total spend + spread multiplier).
  sections/lane-table.ts   §02 — sortable per-lane table (Lane · Model ·
                       Router badge · Pass · $/pass · Judge · Weighted
                       $/pass · p50 · p95 latency). Winner row shaded green.
  sections/heatmap.ts      §03 — lanes × tasks matrix, log10-bucketed
                       gradient, weighted/raw color toggle.
  sections/session-list.ts §04 — collapsible per-session cards. Each
                       shows judge outcome + reasoning + 4 sub-scores
                       + verify_exit_code + stdout tail.
  sections/aggregate.ts    §05 — cost analysis card + "narrated"
                       callout when cheapest-raw diverges from best-value.

Auto-generation is wired: the orchestrator calls `generate()` after
`judgePool.drain()`. `enter` on the LiveProgress "Run complete" screen
opens the report in the default browser.

────────────────────────────────────────────────────────────────────────────
NAMING CONVENTION YOU'LL SEE
────────────────────────────────────────────────────────────────────────────

- **Database columns keep the original names**: `trajectory_score`,
  `trajectory_reasoning`, `trajectory_confidence`. Same for the judge
  prompt (`prompt-haiku-r5-local.md` still uses "trajectory" throughout —
  it's the ML-native term Haiku understands).
- **UI labels use "judge score" everywhere.** The rename is UI-only —
  no migration, no code churn beyond the render layer. If you add a new
  section, use "judge score" in copy. Rendering ct.dimension='trajectory_score'
  as "Judge score" is the pattern.

The composite formula:
  judge score  =  action + grounding + verification + efficiency   (each 0-25)
  weighted \$/pass  =  \$/pass  ÷  (judge score / 100)

────────────────────────────────────────────────────────────────────────────
WHERE TO START
────────────────────────────────────────────────────────────────────────────

1. Read the existing report end-to-end in Chrome. Two options:

   (a) Regenerate against Rupul's job-search-automation run:
       npx tsx -e "import('./src/report/generate.ts').then(m =>
         m.generate('1b48bcaf-95ff-43d1-b7e8-29c4e9a77298',
                    '/Users/rupulsafaya/Documents/GitHub/job-search-automation/.c1'));"
       open /Users/rupulsafaya/Documents/GitHub/job-search-automation/.c1/runs/1b48bcaf-95ff-43d1-b7e8-29c4e9a77298/report/index.html

   (b) Generate your own from `pnpm test:runner` output (see STEP 3).

   Click every collapsible. Expand every session card. Sort every column.
   Toggle the heatmap. See what feels right vs. what feels off.

2. Then read src/report/ end-to-end. 8 small files. Start with generate.ts
   to see how sections compose, then data.ts to see what data they get.

3. Then read c1-report-29july-SPEC.md end-to-end.

Only after that should you write code. The current report is a strong
starting point but has real gaps — see the next section.

────────────────────────────────────────────────────────────────────────────
WHAT'S NOT DONE (WHERE YOU ADD VALUE)
────────────────────────────────────────────────────────────────────────────

**Charts.** Nothing chartable renders anywhere. The lane table + heatmap
are HTML tables. Product0's reference report inlines Chart.js for bar
charts, dumbbell latency plots, and cost distributions. SPEC §5 explicitly
allows inlining Chart.js (~100 KB UMD, embedded into a <script> tag —
NOT a CDN link). Places I'd add charts first:

  - Cost distribution per lane: bar chart of $/pass, sorted.
  - Latency dumbbell: p50 → p95 gap per lane. Wide gap = long-tail
    provider (Phala in the sample run has p95 = 112s vs p50 = 18s —
    huge story that a table row hides).
  - Judge sub-score radar or bar-4 per lane: shows WHERE trajectory
    quality diverges (action = 0 for stateless classifier tests, etc.).

**From/To decision matrix.** SPEC §7 (originally §7.5) had this — a matrix
where each cell says "if I switch from row lane to col lane, delta cost/pass
is X%." Colored SAFE / MARGINAL / REGRESSION. Deferred by Rupul in this
push. This is the single most valuable addition — it directly answers
"should I switch providers" without the user doing arithmetic.

**Per-repeat variance.** Currently the lane table shows aggregates. When a
lane's 3 repeats have very different cost or judge scores, that's signal
about provider stability (Phala repeats varied 2× on latency in the sample
run). Show variance as a small horizontal band on each lane row, or expose
a "repeats" breakdown when the row is expanded.

**Task drilldown.** SPEC §7.4 mentions per-task breakdowns. Currently the
heatmap has task columns but there's no "for task t01, here's how each
lane did" view.

**Chart.js for the trajectory sub-score distribution.** All 6 sessions in
the sample run scored action=0, verification=0. That's a *signal* that
the workload doesn't exercise those dimensions (see SPEC §4.5). A
histogram of sub-scores across all sessions would surface this at a glance.

**Failure taxonomy.** When runs have failures (which the sample doesn't),
`sessions.failure_class` carries values like `auth_failed`, `rate_limited`,
`destination_unavailable`, `timeout`, `setup_error`, `forward_failed`. A
small pie / count breakdown of failure classes per lane would be useful
diagnostic info.

**snapshot test.** SPEC §11 calls for `tests/report.test.mjs`. Not written
yet. Suggested shape: generate against a canned run (checked into
`tests/fixtures/canned-run-1/`), assert key strings appear ("Run report",
best value lane, session count). Content check, not byte-for-byte.

**Copy-to-clipboard buttons** on session IDs, weighted $/pass values,
lane slugs. Small, high polish. SPEC §14 nice-to-have.

**Print stylesheet.** Someone will inevitably want to print or PDF-export.
Add `@media print` rules that hide the "Data inventory" tab and expand
all collapsibles.

**Traj⚠ interpretation banner.** SPEC §4.5 defines a heuristic: if a
session has zero tool_calls across all steps, the ⚠ badge means
"workload doesn't exercise trajectory dimension," not "narrated." The
current report shows ⚠ uniformly. When you detect the classifier-shape
pattern (all sessions have `SUM(tool_calls)=0`), show a banner at the
top explaining the caveat rather than the "narrated" tooltip. See
[`reference_traj_narrated_false_positive.md`] in `.claude/memory/`.

────────────────────────────────────────────────────────────────────────────
WHAT YOU OWN AND WHAT YOU DON'T
────────────────────────────────────────────────────────────────────────────

You own everything under `src/report/` and `tests/report.test.mjs`.

Do NOT touch (Rupul owns these — file an issue instead of editing):
- `src/proxy/`         — the lane proxy
- `src/runner/`        — the run engine (includes orchestrator + judge worker)
- `src/state/`         — the zustand store
- `src/db/sqlite.ts`   — schema. Read from it. If you need a new column,
                         say so in the PR description and Rupul will land
                         a schema-v3 migration.
- `src/scan/`          — repo scanning + methodology
- `src/screens/`       — TUI screens (LiveProgress, etc.)
- `src/judge/`         — judge worker + trajectory summarizer

`src/lib/fmt.ts` — shared formatters (`fmtDollars`, `fmtDuration`) already
imported by the report. Feel free to add more formatters there (they'll
also get picked up by the TUI).

────────────────────────────────────────────────────────────────────────────
STEP 1 — CLONE AND SET UP THE REPO
────────────────────────────────────────────────────────────────────────────

  git clone https://github.com/rupulsafaya/canaryone.git
  cd canaryone
  git config user.email <your-personal-email>
  git checkout -b bhaskar/report-polish
  pnpm install

Node version required: >= 22. Verify with `node --version`.

KNOWN INSTALL HAZARDS:

1. `pnpm approve-builds` will prompt for node-pty. Approve it.

2. On macOS ARM (Apple Silicon), the node-pty prebuild ships non-executable:
     chmod +x node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
   Only needed if `pnpm test:tui` errors with a spawn-helper permission issue.

3. `~/.c1/.env` must exist with `OPENROUTER_API_KEY=sk-or-v1-...`. If you
   don't have one, get from https://openrouter.ai/keys. ~$5 credit is plenty.

Verify install (all should pass out of the box):
  npx tsc --noEmit       # exit 0
  pnpm test:tui          # 13/13 pty scenarios pass
  pnpm test:judge        # judge trajectory + subscores unit tests
  pnpm test:runner       # integration test (~$0.00002). Prints
                         # "outcome=success trajectory=50" + auto-generates
                         # a report in the scratch tmpdir.

────────────────────────────────────────────────────────────────────────────
STEP 2 — OPEN THE EXISTING REPORT
────────────────────────────────────────────────────────────────────────────

The fastest way to understand what's shipped is to look at it:

  # Regenerate against the reference run:
  npx tsx -e "import('./src/report/generate.ts').then(m => m.generate(
    '1b48bcaf-95ff-43d1-b7e8-29c4e9a77298',
    '/Users/rupulsafaya/Documents/GitHub/job-search-automation/.c1'))"

  # Open in default browser:
  open /Users/rupulsafaya/Documents/GitHub/job-search-automation/.c1/runs/1b48bcaf-95ff-43d1-b7e8-29c4e9a77298/report/index.html

Note: `file://` URLs work in browsers directly. Chrome extensions
(including AI dev tools) can't reach them due to same-origin — if you
need one to inspect, spin up `python3 -m http.server 8842` in the
report directory.

Alternatively, regenerate for a fresh run of your own:

  pnpm test:runner
  # Note the "wrote:" path in the output — it points at report/index.html.
  open /tmp/c1-runner-<random>/.c1/runs/<runId>/report/index.html

────────────────────────────────────────────────────────────────────────────
STEP 3 — DATA CONTRACT REFERENCE
────────────────────────────────────────────────────────────────────────────

Read these when you need to reach for new data:

  src/db/sqlite.ts          SQLite schema — RunRow, SessionRow, StepRow,
                            ClassifierTagRow types. Lines ~15-140.
  src/runner/traffic-log.ts JSONL record shape (TrafficRecord type).
                            iterRecords() is the streaming helper.
  src/report/data.ts        What the renderers actually get. loadRun()
                            returns everything you need in one call.
                            LaneRollup shape matches what §01/02/03/05
                            all consume — build on top rather than
                            re-deriving.

Poke at a canned run with the SQLite CLI:

  DB=tests/fixtures/openai-sdk-echo/.c1/db.sqlite  # or a /tmp run

  sqlite3 "$DB" '.tables'
  sqlite3 "$DB" '.schema classifier_tags'

  # Judge score row breakdown per session (the pivot data.ts already does):
  sqlite3 -column -header "$DB" "
    SELECT substr(s.id,1,8) sess, s.destination_slug,
           MAX(CASE WHEN ct.dimension='outcome' THEN ct.value END) outcome,
           MAX(CASE WHEN ct.dimension='trajectory_score' THEN ct.value END) judge,
           MAX(CASE WHEN ct.dimension='action_score' THEN ct.value END) act,
           MAX(CASE WHEN ct.dimension='grounding_score' THEN ct.value END) grnd,
           MAX(CASE WHEN ct.dimension='verification_score' THEN ct.value END) vfy,
           MAX(CASE WHEN ct.dimension='efficiency_score' THEN ct.value END) eff
    FROM sessions s LEFT JOIN classifier_tags ct ON ct.session_id = s.id
    GROUP BY s.id;
  "

And the JSONL:

  head -3 tests/fixtures/openai-sdk-echo/.c1/runs/*/traffic.jsonl \
    | python3 -m json.tool

Do not speculate about shapes — read the tables.

────────────────────────────────────────────────────────────────────────────
STEP 4 — ITERATE
────────────────────────────────────────────────────────────────────────────

Pick something from "WHAT'S NOT DONE" above (or something you notice
while reading the existing report). For each iteration:

1. Add or modify code under `src/report/` only.
2. Regenerate the report:
     npx tsx -e "import('./src/report/generate.ts').then(m => m.generate(
       '<runId>', '<configDir>'))"
3. Reload in Chrome. Confirm no console errors:
     Chrome DevTools → Console tab. Warnings/errors here are bugs.
4. Read the file size. Should stay under 500 KB even with charts inlined
   (SPEC §3 target: under 1 MB).
5. Commit incrementally on the `bhaskar/report-polish` branch.

If you want to bring in a chart library — inline Chart.js 4.x UMD into
`scripts.ts` (fetch once, paste the minified content into a template
literal). Do NOT use a CDN. The report must open offline via `file://`.

If you find yourself wanting a new column in SQLite (e.g., cache_hit_rate,
provider_latency_percentile), write it up in the PR body and Rupul lands
the schema change on the runner side. Do NOT edit `src/db/sqlite.ts` or
the orchestrator yourself — those are tightly wired to the TUI and lane
proxy and easy to break.

────────────────────────────────────────────────────────────────────────────
STEP 5 — COMMIT + PR
────────────────────────────────────────────────────────────────────────────

You're on branch bhaskar/report-polish. Before you push:

  npx tsc --noEmit       # exit 0
  pnpm test:tui          # regression — should still be 13/13
  pnpm test:judge        # regression — trajectory + subscores unit tests
  pnpm test:runner       # regression — outcome=success + 8 judge tags
                         # + auto-generated report renders without errors
  # If you added tests/report.test.mjs:
  npx tsx tests/report.test.mjs

Commit with descriptive messages. Push to origin. Open PR against main.
Rupul reviews.

────────────────────────────────────────────────────────────────────────────
QUESTIONS
────────────────────────────────────────────────────────────────────────────

- Anything unclear about how to compute a metric → read
  `src/runner/print-summary.ts` (has all the roll-up math) or
  `src/report/data.ts::computeLaneRollups` (same, extended for the report).
- Anything about what a judge dimension means → read
  `src/judge/prompt-haiku-r5-local.md` and c1-report-29july-SPEC §11.2.
- Anything about the ⚠ workload-shape caveat → SPEC §4.5.
- Ping Rupul in Slack for anything else.

Do NOT modify anything outside `src/report/` or `tests/report.test.mjs`
without explicit approval.

Now: read the SPEC, open the existing report in Chrome, then start iterating.
