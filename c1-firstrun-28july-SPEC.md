# canaryone first-run scan — v0.0 SPEC

**Status:** **built** 2026-07-28 — merged into `tui-mock` working tree (not yet in main). All sections implemented; 10 pty scenarios pass; walked end-to-end against `job-search-automation` on a real OR key.
**Amendment 2026-07-28:** key-first flow — new KeySetup screen renders before Onboarding; OR key detection chain now includes `~/.c1/.env` (global); prompted keys save there by default; credits validated on welcome. Onboarding wizard drops the OR-key row (3 rows now: Runner / Test glob / Found). Optional `OR_JUDGE_KEY` env-var override supported but not surfaced. See §1, §3.3, §7 as-written for details; treat this amendment as authoritative where they conflict.

**Amendment 2026-07-28 (b):** post-scan summarization — new `SummarizeTasks` screen between Onboarding and PickTasks reads each matched test with Claude Haiku 4.5 and produces `{summary, bullets, usesLLM, llmEvidence}` per file. Persisted into `Config.tasks.summaries` map. Cached by mtime; invalidated when file changes or schema version bumps. PickTasks displays an `LLM` column (● yes / ○ no / ? unknown) and an `x` bulk-uncheck non-LLM tests. Cost: ~$0.002/test via OR. Reconciles §2 non-goal "no LLM classification" — this pass is *description* (what the test does) plus a *yes/no LLM invocation flag*, not the deferred v0.1 agent-relevance classifier.

**Amendment 2026-07-28 (c):** OR catalog cache location moved from `<configDir>/or-catalog.json` to `~/.c1/or-catalog.json` (global). Rationale: catalog is user-scoped truth, not repo-scoped. Mirrors how `~/.c1/.env` works. One fetch per 24h across all repos. Trade-off: dev tests can no longer isolate via `--config-dir`; if needed, delete `~/.c1/or-catalog.json` between runs.
**Scope:** iter1 build target. Replaces the mocked "Scanning repo" auto-progress in Onboarding with real detection + user-confirm.
**Parent SPEC:** [`c1-local-SPEC-2707-v0.md`](./c1-local-SPEC-2707-v0.md) — §3 step 2, §3.5, §6 need cleanup after this ships (drift noted at bottom).

---

## 1. Purpose

Two-step first-run flow:

**Step 1 — Key setup (welcome screen).** Detect or prompt for the user's OpenRouter API key. Validate against the credits endpoint. Save prompted keys to `~/.c1/.env` by default so they persist across all repos on this machine.

**Step 2 — Deterministic scan (per-repo).** Detect in the target repo:

1. How to invoke tests (`runner`).
2. Which files are agent-relevant tests (`testGlob` → matched files).

Confirm with the user in a single batch screen. Persist the confirmed answers to `.c1/config.json`. Downstream screens (PickTasks etc.) read from that file.

**Key model:** one required OR key (used for catalog fetch, benchmark routing, and judge). Optional `OR_JUDGE_KEY` env-var override for users who want to isolate judge billing / rate limits / provider — not surfaced in the wizard.

**No LLM classification in this iteration.** Deferred to v0.1. Rationale: unproven product, ship the minimum that works; scan-then-ask covers the 80% case; classifier helps at the edges but not enough to justify iter1 scope.

## 2. Non-goals (locked v0.0)

- LLM classification of tests (v0.1)
- Task authoring wizard when zero tests found (v0.1 — v0.0 keeps the wizard open until user quits or fixes the glob)
- Delete-and-recover synthesis (v0.1)
- `.c1/db.sqlite` (iter2 — v0.0 uses `.c1/config.json` + `.c1/scan.json` only)
- Auto-rescan on `package.json` mtime change (v0.1 — v0.0 requires explicit `--rescan`)
- Cross-run comparison (v0.1+)

## 3. Data model

### 3.1 `.c1/config.json` — persisted, user-editable

Source of truth after first run. Written by the wizard on Enter; downstream screens read from it.

```ts
ConfigSchema = {
  version: "0.0",                       // literal
  targetDir: string,                    // absolute path; warn if load-time cwd differs
  runner: {
    cmd: string,                        // e.g. "pnpm test"
    cwd: string | null,                 // relative to targetDir; null = targetDir
    detectedFrom: "package.json" | "pyproject.toml" | "Makefile" | "user",
  },
  testGlob: {
    pattern: string,                    // user-facing: plain path OR full glob
    expanded: string,                   // fully-expanded glob after auto-expansion
  },
  tasks: {
    included: string[],                 // relative paths; PickTasks selection persists here
  },
  orKey: {
    source: "env:OPENROUTER_API_KEY" | "env:OR_KEY" | ".c1/.env" | "prompt",
    // the key itself is NEVER persisted here — only the source
  },
  createdAt: string,                    // ISO, stamped once
  updatedAt: string,                    // ISO, refreshed on every write
}
```

### 3.2 `.c1/scan.json` — auto-cached, ephemeral

Result of the last deterministic scan. Cheap to regenerate. Invalidated by `--rescan` or any change in `fingerprint`.

```ts
ScanSchema = {
  version: "0.0",
  scannedAt: string,                    // ISO
  fingerprint: {
    packageJsonMtime: number | null,    // ms; null if file absent
    pyprojectMtime: number | null,
    makefileMtime: number | null,
  },
  runners: [{ cmd: string, source: string, priority: number }],  // ranked candidates
  probedDirs: [{ path: string, exists: boolean, fileCount: number }],
  frameworkHints: string[],             // e.g. ["next.config.ts", ".opencode/"]
}
```

**OR catalog is NOT in `scan.json`.** It moved to PickModels — see §7.

### 3.3 `.c1/.env` — dotenv format

Optional. Simple `KEY=value` parser. Zod validates presence of `OPENROUTER_API_KEY` when consulted. Never checked into git.

## 4. Deterministic scan

Pure. No network. No LLM. Read-only against `targetDir`.

```ts
// src/scan/deterministic.ts
export async function scanDeterministic(targetDir: string): Promise<DeterministicScan>;

export interface DeterministicScan {
  runners: RunnerCandidate[];         // ranked; top-scored is default in wizard
  probedDirs: ProbedDir[];
  frameworkHints: string[];
  suggestedGlob: string | null;       // best guess from probedDirs, or null
}
export interface RunnerCandidate {
  cmd: string;
  source: "package.json:test" | "package.json:test:unit" | "package.json:test:e2e"
        | "pyproject.toml" | "Makefile:test" | "fallback";
  priority: number;                   // higher = better
}
export interface ProbedDir { path: string; exists: boolean; fileCount: number; }
```

### 4.1 Readers (run in parallel, merged)

- **`readPackageScripts(dir)`** — parse `package.json.scripts`. Emit candidates for keys matching `/^test(:.*)?$/`. Priority: `test` → 100, `test:unit` → 90, `test:agent` → 95, `test:e2e` → 70, other `test:*` → 60. Command form: `<pkgMgr> <scriptName>` where `<pkgMgr>` is inferred from lockfile presence (`pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, else `npm`).
- **`readPyproject(dir)`** — parse `pyproject.toml`; look for `[tool.pytest]`, `[tool.poetry.scripts]`. Base priority 50.
- **`readMakefile(dir)`** — grep for `^test:` target. Base priority 40.
- **`probeTestDirs(dir)`** — fixed list: `tests/agent/`, `tests/agents/`, `test/agent/`, `__tests__/agent/`, `tests/integration/`, `tests/e2e/`. Each: existence + shallow file count via `fast-glob`.

### 4.2 `suggestedGlob`

First entry in `probedDirs` that exists AND has `fileCount > 0`, run through `glob.ts` auto-expansion (§5). If no probed dir qualifies: `null` (wizard renders "no test dir detected — edit glob").

## 5. Glob expansion — `src/scan/glob.ts`

Accept either:

- **Plain path** (e.g. `tests/agent/`) → auto-expand to `<path>/**/*.{spec,test}.{ts,tsx,js,mjs,py}`
- **Full glob** (contains `*` or `{}`) → pass through unchanged

Enumerate matches via `fast-glob` (or `tinyglobby` if we want to shave a dep). Return absolute paths + relative-to-targetDir for display.

```ts
export function expandGlob(pattern: string): string;   // plain path → glob; glob → same
export async function matchFiles(targetDir: string, pattern: string): Promise<{ absolute: string; relative: string; }[]>;
```

## 6. Orchestrator — `src/scan/orchestrator.ts`

Ties it together. Called once from Onboarding on mount.

```ts
export async function runFirstRunScan(opts: {
  targetDir: string;
  configDir: string;              // usually targetDir + "/.c1"
  forceRescan?: boolean;
}): Promise<{
  scan: DeterministicScan;
  config: Config | null;          // existing config if present
  orKey: { present: boolean; source: Config["orKey"]["source"] | null; };
}>;
```

Behavior:

1. If `config.json` exists AND `scan.json` exists AND fingerprint unchanged AND `!forceRescan` → return cached.
2. Else: run `scanDeterministic`, write `scan.json`.
3. Read existing `config.json` if any; user edits win on merge.
4. OR key detection: probe `$OPENROUTER_API_KEY`, then `$OR_KEY`, then `<configDir>/.env`. Report source; do NOT read the value into memory here (defer until we need it).

## 7. OR catalog — moved to PickModels

Onboarding does not fetch. First entry into PickModels:

- Read `<configDir>/or-catalog.json` if present and `fetchedAt < 24h ago` → use it.
- Else: fetch `GET https://openrouter.ai/api/frontend/v1/rankings/models?view=day&models=all` + credits endpoint. Write `<configDir>/or-catalog.json`. TTL 24h. Fall back to alphabetical + "credits unknown" on 404/network error.

Cache location keyed by `configDir` (not `~/.cache/`) so `--config-dir /tmp/c1-scratch` isolates test runs.

## 8. Batch-confirm wizard — Onboarding rewrite

Replaces the current 5-row sequential-progress screen. Fixed-height stays: rows render from t=0 with `scanning…` state, flip to values once `scanDeterministic` resolves (~10–50ms typical).

### 8.1 Layout

```
Scan complete. Confirm and continue?
  Runner        pnpm test                          [e]dit
  Test glob     tests/agent/**/*.{spec,test}.ts    [e]dit
  Found         12 test files                      [v]iew
  OR key        ✓ from environment                 [e]dit
  [↑↓] pick field · [enter] accept · [e] edit · [q] quit
```

### 8.2 Field cursor + edit interaction

- Cursor starts on the first row.
- `↑↓` moves cursor between editable rows (Runner, Test glob, OR key). "Found" is a view-only row.
- `e` opens an inline editor for the highlighted row (masked prompt if OR key row).
- Enter with cursor on any non-editing state → accept all values, write `config.json`, advance to PickTasks.
- `q` or Esc → exit process 0.

Diverges from Confirm.tsx's per-field-hotkey pattern (`c`/`p`/`r`) because we have variable-typed fields and fewer of them; cursor mode reads cleaner.

### 8.3 Editors

- **Runner**: plain text input; commit on Enter.
- **Test glob**: shows the *original pattern* (not the expanded form). On Enter: re-expand via `glob.ts`, re-run `matchFiles`, update Found count in place. If new count is 0 → row shows red "0 files", Enter to accept whole wizard is disabled until non-zero.
- **OR key**: masked input (`•••…`); on Enter, write to `.c1/.env` as `OPENROUTER_API_KEY=…`. Update source to `.c1/.env`.
- **Esc** in editor: cancel, restore prior value.

### 8.4 `[v]iew` action on Found row

- Press `v` when cursor is on Found → sub-screen listing matched files (scrollable, reuse PickTasks' scroll-window pattern).
- `Esc` or `b` returns to wizard.

### 8.5 Zero-tests behavior

When `matchFiles` returns 0:

- Wizard renders `Found  0 test files  ⚠ edit glob to fix`.
- Enter is disabled (accept blocked).
- Only `e` (edit glob) or `q` (quit) accepted.
- User can iterate glob edits until non-zero. No forced hard exit mid-edit.

Matches parent SPEC §3.5 intent (non-zero exit if zero) while preserving usability — user quits deliberately, not automatically.

## 9. CLI flags (new)

- `--target <dir>` — target repo (default: `cwd`). Enables iterating from the canaryone dir itself.
- `--config-dir <path>` — where `.c1/` lives (default: `<targetDir>/.c1`). Env: `C1_CONFIG_DIR`. Redirect to `/tmp/c1-scratch-*` during dev testing to keep the target repo clean.
- `--rescan` — invalidate `scan.json` cache; re-run deterministic scan.
- `--start <screen>` — existing flag; unchanged. Fixture path guarded (see §11).

## 10. State store additions

```ts
// src/state/store.ts additions
scanResult: DeterministicScan | null;
config: Config | null;
orKeyPresent: boolean;
orKeySource: Config["orKey"]["source"] | null;
matchedFiles: { absolute: string; relative: string; }[];
setScanResult(r: DeterministicScan): void;
setConfig(c: Config): void;
acceptWizard(): void;                   // writes config.json, advances to pickTasks
```

PickTasks reads from `config.tasks` (matched files, minus the `included = false` set) when `config != null`. Falls back to fixtures when `config == null` — i.e. `--start pickTasks` still works on fixtures.

## 11. Fixture guard

`--start pickTasks|taskDetail|pickModels|pickDestinations|confirm|liveProgress` must continue to work with fixtures. Guard: if `--start` is set AND `config == null`, PickTasks reads from fixtures. Do not run the scan on `--start` paths that skip Onboarding.

## 12. Non-invasive testing

We will iterate against real repos many times. To avoid dirtying them:

- Default `configDir` = `<targetDir>/.c1/` (SPEC-conformant, real users see this).
- During dev: `pnpm dev -- --target ~/Documents/GitHub/canaryone-cloud --config-dir /tmp/c1-scratch-cc` — no `.c1/` written into target repo, no gitignore mutation, `rm -rf /tmp/c1-scratch-cc` resets state cleanly between iterations.
- The scan itself is read-only against `targetDir`. Only `configDir` gets writes.

## 13. Build order

1. `src/data/schema.ts` — Zod schemas.
2. `src/scan/glob.ts` — expand + match.
3. `src/scan/deterministic.ts` — readers + orchestration.
4. `src/scan/orchestrator.ts` — cache + config merge + OR key detection.
5. `src/state/store.ts` — new state slice.
6. `src/cli.tsx` — `--target`, `--config-dir`, `--rescan` flags.
7. `src/screens/Onboarding.tsx` — full rewrite.
8. Fixture-guard tweak in `PickTasks.tsx`.

## 14. Test targets (in order)

1. `~/Documents/GitHub/canaryone-cloud` — Node repo with no test script, no `tests/` dir → exercises the zero-tests path (§8.5) cleanly.
2. `~/Documents/GitHub/job-search-automation` — check the next real target.

**Success criterion:** `pnpm dev -- --target <repo> --config-dir /tmp/c1-scratch` inside canaryone → batch-confirm screen shows correct runner + real matched-file count → user hits Enter → PickTasks lists real tests from that repo.

## 15. SPEC drift owed (parent spec cleanup)

Cleanup owed to `c1-local-SPEC-2707-v0.md` after iter1 ships:

- §3 step 2 currently says "LLM-classified pass" → revise to "user-confirmed after deterministic scan".
- §3.5 (Pick tasks) says "already-classified agent-relevant tests" → revise to "tests matching your configured glob".
- §6 (Codebase scan) currently describes an LLM pass → split into "v0.0 deterministic-only" vs "v0.1 LLM-assisted".
- §12 schema still uses `sessions.host` → rename to `sessions.destination_slug` + `sessions.router` (unrelated to this scan work, but same cleanup pass).

## 16. Run-dir lifecycle (forward note)

Two separate lifecycles under `.c1/`:

- **Cache-shaped, single-file, overwritten:** `.c1/config.json`, `.c1/scan.json`, `.c1/or-catalog.json`. Derived or persisted-decision data. History is either unnecessary (caches) or lives in git (config).
- **Run-shaped, per-run, immutable:** `.c1/reports/<ts>/`, per-run worktrees, `.c1/db.sqlite` row-keyed by `run_id`. Written by `c1 run`, not by Onboarding.

Onboarding writes only to the cache-shaped bucket.

**iter2 obligation (not this iter):** when the real runner lands, `c1 run` must snapshot `config.json` and `scan.json` into its per-run dir (e.g. `.c1/runs/<ts>/setup.json`) at launch, so a run remains reproducible even if the top-level cache is later mutated or invalidated. Top-level `.c1/scan.json` stays "latest cache"; the snapshot is the run's ground truth.

## 17. Provenance

- Design conversation: session `c1-build-28july`, 2026-07-28
- Parent SPEC: `c1-local-SPEC-2707-v0.md`
- TUI mock this replaces: `tui-mock` branch, `src/screens/Onboarding.tsx` at `f28a710`
