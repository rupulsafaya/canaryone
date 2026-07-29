# Kickoff prompt — SPEC 1 Part B (judge)

**How to use:** open a fresh Claude Code session in the canaryone repo root, paste everything between the `───` markers below into the first message. Read the SPEC alongside while Claude works.

**Scope:** Part B (judge) ONLY. Part A (multi-router) comes next in a separate session. Do not let the fresh Claude wander into `src/proxy/providers.ts` or `TokenManager.tsx` — those belong to Part A.

---

You are implementing Part B of `c1-launch-29july-SPEC.md` in the canaryone
repo. Part B is the judge — a Haiku-driven trajectory quality scorer that
runs alongside the runner and writes per-session verdicts + a 0-100
trajectory score into SQLite.

Part A of the same SPEC (multi-router forwarding + TokenManager screen)
lands in a DIFFERENT session. Do not touch it. Files that belong to Part A:
  - src/proxy/providers.ts (new — Part A)
  - src/screens/TokenManager.tsx (new — Part A)
  - LaneSpec extension in src/state/store.ts (Part A)
  - PickDestinations.tsx changes (Part A)

If the SPEC references them, they'll show up as pre-existing when Part A
ships. For Part B assume LaneSpec today = the D2 shape (no forwardUrl yet).

────────────────────────────────────────────────────────────────────────────
CURRENT STATE OF THE REPO (2026-07-29, main @ 995b5b9)
────────────────────────────────────────────────────────────────────────────

Shipped:
- D1 (methodology detection) — `src/scan/methodology.ts`, blocks
  sdk-hardcoded and no-sdk-detected repos
- D2 (base runner) — proxy/lane.ts + runner/{orchestrator,subprocess,
  worktree,traffic-log,event-bus}.ts + db/sqlite.ts
- LiveProgress live-event wiring + $/pass column + end-of-run actions

Not shipped, in this SPEC:
- Part A (multi-router + TokenManager) — separate session
- Part B (judge) — this session
- SPEC 2 (HTML report) — Bhaskar, separate PR, branch bhaskar/html-report

Regression signal:
  npx tsc --noEmit       # must stay exit 0
  pnpm test:tui          # 13 pty scenarios, must stay green
  pnpm test:runner       # integration test, must stay green

────────────────────────────────────────────────────────────────────────────
READ FIRST (in order)
────────────────────────────────────────────────────────────────────────────

1. `c1-launch-29july-SPEC.md` sections §9 through §16 — the ONLY sections
   relevant to Part B. Sections §3–§8 are Part A; skip.

2. The source you're porting from (READ-ONLY reference, don't edit):
   `~/Documents/GitHub/canaryone-cloud/scripts/judge_v1.ts`
   Focus on lines 25–401 (constants + trajectory summarizer + file-diff
   helpers + prompt) and 449–473 (parseJudgeContent).

3. Current runner internals so you know where the judge hooks in:
   - `src/runner/orchestrator.ts` — the RunEngine class. After each session
     terminates in `runOne()`, you'll enqueue a judge job.
   - `src/runner/traffic-log.ts` — TrafficRecord shape + readRange + the
     iterRecords helper for streaming JSONL back.
   - `src/db/sqlite.ts` — the schema. `classifier_tags` table is generic
     (dimension/value pairs) — write your subscore + outcome rows into it.

4. Integration test as reference harness:
   `tests/runner.test.mjs` — this is where you extend to assert judge tags
   land after the session completes.

────────────────────────────────────────────────────────────────────────────
GATES / INVARIANTS
────────────────────────────────────────────────────────────────────────────

- **verification_exit_code is ground truth for outcome.** Never override.
  If the test passed (exit 0), the judge's `outcome` field is "success"
  with high confidence. Judge only annotates trajectory quality; never
  contradicts the customer's test.

- **Half the sub-scores are computed, half LLM-judged.** Action + Efficiency
  are computed from JSONL — no LLM subjectivity. Grounding + Verification
  come from Haiku. Trajectory composite = sum. Auditable.

- **Composite formula: `action + grounding + verification + efficiency`.**
  Each 0-25. Total 0-100 by construction. Do not weight or scale.

- **Prompt version: `2026-07-29-haiku-r5-local`.** Writes into
  `classifier_tags.classifier_version`.

- **Judge concurrency = 3.** Judge worker pool runs in parallel with the
  runner. When a session terminates, its judge job is enqueued and worked
  by one of the 3 workers while the next session batch keeps running.

- **`node:sqlite` schema is generic dimension/value.** You don't add
  columns. You add ROWS with new dimensions:
    outcome, trajectory_score, action_score, grounding_score,
    verification_score, efficiency_score, trajectory_reasoning,
    judge_reasoning

────────────────────────────────────────────────────────────────────────────
ORDER OF IMPLEMENTATION
────────────────────────────────────────────────────────────────────────────

Suggested milestone commits (all directly to main; canaryone's pattern):

Milestone J1: port trajectory helpers
  - src/judge/trajectory.ts (new)
    - Port summarizeTrajectory, compactFileDiff, extractFilePath,
      extractFileContentLines, budget constants (lines 25–401 of
      canaryone-cloud/scripts/judge_v1.ts)
    - Input adapted: instead of a Task with .traces, take a session_id +
      the JSONL log path. Walk request/response records for that session.
    - Output: same shape — a string trajectory summary suitable for the
      judge prompt.
  - Unit-test: feed the trajectory helper a canned session (from an
    existing pnpm test:runner output) and assert the file-re-read diff
    logic collapses second reads of the same file.

Milestone J2: computed sub-scores
  - src/judge/subscores.ts (new)
    - computeActionScore(sessionId, db) → 0-25 based on turns-with-tool-call
      / total turns. Read step rows; a step is a "turn with tool call" if
      its response body contains tool_calls or the next step's request has
      role=tool messages. Single-turn workloads score 25 by default.
    - computeEfficiencyScore(sessionId, db, jsonlPath) → 0-25 based on
      unique_tool_signatures / total_tool_calls. Signature =
      (tool_name, canonicalized args JSON).
    - Both return {score: 0-25, evidence: string} — evidence goes into the
      trajectory_reasoning row for debuggability.

Milestone J3: git-diff signal
  - src/judge/git-diff.ts (new)
    - captureGitDiff(worktreePath) → { files_changed, insertions,
      deletions, paths[] } via execFile('git', ['diff', 'HEAD',
      '--shortstat']) + '--name-only'. On non-git worktrees returns
      zeros with paths=[].

Milestone J4: prompt file + Haiku caller
  - src/judge/prompt-haiku-r5-local.md (new)
    - The full JUDGE_SYSTEM prompt from SPEC §11.1 + §11.2. Copy the
      base structure from canaryone-cloud/scripts/judge_v1.ts JUDGE_SYSTEM
      constant. Replace the STRONGEST SIGNAL section (lines 421–429 of
      the source) with the verification_exit_code section from SPEC §11.1.
      Add the TRAJECTORY SCORE section from SPEC §11.2. Drop the
      not_a_task outcome from the schema.
  - src/judge/haiku-r5.ts (new)
    - export judgeSession(sessionId, {db, jsonlPath, worktreePath, orKey,
      verifyExitCode, testFile}) → Verdict
    - Assemble the user message: task prompt, trajectory summary from J1,
      computed sub-scores from J2, git_diff_summary from J3, verify exit
      code, final assistant response
    - POST to OR /api/v1/chat/completions with model
      anthropic/claude-haiku-4.5, temperature 0, max_tokens 400
    - Parse via parseJudgeContent (port from source, lines 449–473)
    - Combine: trajectory_score = action + grounding (from LLM) +
      verification (from LLM) + efficiency
    - Return { outcome, confidence, reasoning, trajectory_score,
      trajectory_confidence, action, grounding, verification, efficiency,
      trajectory_reasoning }

Milestone J5: SQLite writes
  - Extend src/db/sqlite.ts with a small helper:
      insertClassifierTags(sessionId, verdict) — batch-inserts one row per
      dimension: outcome, trajectory_score, action_score, grounding_score,
      verification_score, efficiency_score, judge_reasoning,
      trajectory_reasoning. classifier_id = 'canaryone_judge_v1_local',
      classifier_version = '2026-07-29-haiku-r5-local'.

Milestone J6: worker pool + orchestrator hook
  - src/judge/worker.ts (new) — JudgeWorkerPool class:
    - Constructor takes concurrency (default 3), db, orKey
    - enqueue(sessionId, context) — pushes onto internal queue
    - drain() — resolves when all queued jobs complete
    - Internal loop pulls jobs and calls judgeSession() from J4
    - Emits event on the runner event-bus when each verdict lands
      (new event 'session:judged' with the verdict; LiveProgress can
      optionally render a small badge later)
  - src/runner/orchestrator.ts — in RunEngine.run():
    - Instantiate JudgeWorkerPool
    - After each session terminates (end of runOne), enqueue a judge job
      with { sessionId, jsonlPath, worktreePath: pre-cleanup snapshot,
      verifyExitCode, testFile }
    - IMPORTANT: git diff needs to capture BEFORE the worktree is cleaned
      up. Options: (a) run captureGitDiff INSIDE runOne before cleanup and
      pass it into the enqueue; (b) move cleanup into the judge job.
      Option (a) is cleaner — runOne stays synchronous over the worktree.
    - Before returning from RunEngine.run(): await pool.drain() so all
      verdicts are recorded before the run marker "complete" is written.

Milestone J7: integration test + regression
  - Extend tests/runner.test.mjs:
    - After the existing PASS assertions, query classifier_tags for the
      session. Assert rows exist for: outcome, trajectory_score,
      action_score, grounding_score, verification_score, efficiency_score.
    - Assert outcome = 'success' (the fixture's echo test passes).
    - Assert trajectory_score is an integer 0-100.
  - Full regression pass:
      npx tsc --noEmit    # exit 0
      pnpm test:tui       # 13/13
      pnpm test:runner    # green, with judge tags
  - Commit each milestone (J1..J7) to main with a descriptive message.

Milestone J8: run-complete ASCII summary
  - src/runner/print-summary.ts (new)
    - export printRunSummary(runId, configDir, {stream = process.stdout})
      → void
    - Opens .c1/db.sqlite read-only, queries sessions + classifier_tags
      for the given runId, joins them into per-lane rollups:
        - Pass count / total attempts
        - Sum(cost_usd) as spend
        - AVG(trajectory_score) per lane (from classifier_tags where
          dimension='trajectory_score', value cast to integer)
        - $/pass = spend / passes  (undefined if 0 passes)
        - weighted $/pass = ($/pass) / (avg_traj / 100)  (undefined if
          traj tags missing — column simply omitted)
    - Renders an ASCII table matching this shape:

        === Run complete · <shortId> ===

        Lane                             Pass   $/pass      Traj   Weighted $/pass
        ─────────────────────────────────────────────────────────────────────────
        ● direct:nebius                  6/6    $2.75e-6    92     $2.99e-6
        ● openrouter:moonshotai          6/6    $2.83e-5    88     $3.22e-5
        ● direct:groq                    6/6    $8.00e-7    34 ⚠   $2.35e-6
        ...

        Best value: direct:nebius   ($2.99e-6 per grounded pass, traj 92)
        Cheapest raw: direct:groq   ($8.00e-7 per pass, traj 34 ⚠ narrated)
        ─────────────────────────────────────────────────────────────────
        Total spend: $0.0324   Elapsed: 38s   Judge cost: $0.03

    - Sort default: weighted $/pass ascending (best-value first). Rows
      with 0 passes go to the bottom.
    - "⚠" badge on Traj < 50.
    - "Best value" line names the lane with the lowest weighted $/pass
      among those with ≥1 pass. "Cheapest raw" is the lane with the
      lowest raw $/pass regardless of traj — surfaces the punchline row.
    - If NO judge tags exist for the run (e.g. someone ran the runner
      without the judge worker enabled), gracefully omit the Traj +
      Weighted columns and the two summary lines. Still prints the
      basic pass / $/pass / spend table.

  - Reuse fmtDollars from src/screens/LiveProgress.tsx — extract it to
    src/lib/fmt.ts on the way (also import into LiveProgress.tsx).
    fmt.ts should export fmtDollars + fmtDuration + any other formatter
    that LiveProgress and print-summary both need.

  - Hook in src/runner/orchestrator.ts:
    - Import printRunSummary
    - Call it AFTER await pool.drain() but BEFORE the final `run:complete`
      event is emitted and the function returns
    - Guard: only print when process.stdout.isTTY OR when opts.printSummary
      is truthy (default true). This lets tests silence output if they need to.
    - The Ink TUI writes to stdout too — coordination note: LiveProgress
      renders inside Ink's alternate-screen buffer. When Ink unmounts on
      run-complete (existing behavior in App/exit path), the alternate
      buffer is restored and normal stdout is available. Verify the
      summary appears cleanly below the last TUI frame — if not, gate it
      to fire only in headless mode (from tests) and add a `c1 runs
      summary <runId>` CLI subcommand for post-run terminal review.

  - Extend tests/runner.test.mjs:
    - Capture the child's stdout during the test (already available via
      the spawned process pattern) or call printRunSummary(runId,
      configDir, {stream: <string-collector>}) directly after the run.
    - Assert stdout contains "Run complete", the runId short prefix,
      "Best value:", and the fixture's lane (openrouter:openai when
      running against openai/gpt-oss-20b).

────────────────────────────────────────────────────────────────────────────
COST + TIMING
────────────────────────────────────────────────────────────────────────────

- Judge model: anthropic/claude-haiku-4.5 via OPENROUTER_API_KEY (or
  OR_JUDGE_KEY if set — same pattern as canaryone-cloud). ~$0.005/session.
- Concurrency 3 keeps judge running alongside runner without saturating OR
  rate limits.
- End-to-end for a 6-session fixture run: judge adds ~2 seconds latency
  (post-run drain) at ~$0.03 total.

────────────────────────────────────────────────────────────────────────────
EXIT CRITERION (Part B)
────────────────────────────────────────────────────────────────────────────

Signals:
  - pnpm test:runner passes with additional judge assertions
  - .c1/db.sqlite has 8 classifier_tags rows per session (the 6 dimensions
    from J5 + 2 for classifier_id/version metadata is stored in every row,
    so actual row count is 6+ per session)
  - trajectory_score is deterministic-modulo-LLM: same JSONL should
    always yield the same action + efficiency scores. Grounding and
    verification will vary slightly per Haiku call.
  - stdout at end of `pnpm test:runner` shows the Lane / Pass / $/pass /
    Traj / Weighted $/pass table from J8. This is the "did it work"
    signal a human can eyeball.
  - tsc + pty regression clean
  - Commit history: J1..J8 as separate commits on main

Once J8 lands, ping Rupul to review and unblock Part A (multi-router)
implementation.

────────────────────────────────────────────────────────────────────────────
QUESTIONS OR AMBIGUITY
────────────────────────────────────────────────────────────────────────────

If the SPEC is ambiguous on something, prefer the interpretation that:
  1. Never overrides the customer's test result
  2. Keeps computed sub-scores separate from LLM-judged sub-scores
  3. Fails safe — if the judge call errors, write outcome from the exit
     code alone with trajectory_score = 0 (unknown quality), not a crash

For anything unclear beyond that, ask before writing code.

Now: read the SPEC (§9–§16), read the source judge_v1.ts, then start on J1.
