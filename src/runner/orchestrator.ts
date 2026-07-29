// Run engine: iterates (task × lane × repeat), creates a worktree per session,
// spins a per-lane proxy on an ephemeral port, spawns the subprocess with the
// proxy in front, records the round-trip to JSONL + SQLite, tears down.
//
// M1 scope: OpenAI-compat inbound only, single-file per session, non-streaming.
// Parallelism honored via a simple semaphore.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';

import type { Config, OrCatalog, OrEndpoint } from '../data/schema.js';
import { detectOrKey, ensureGitignore } from '../scan/orchestrator.js';
import { Db, DB_FILE_NAME, type SessionStatus } from '../db/sqlite.js';
import { openTrafficLog, writeRunMeta, writeSessionMarkdown, type TrafficLog, type RunMeta } from './traffic-log.js';
import { createWorktree, ensureDepsCache, symlinkNodeModules, gcOldWorktrees } from './worktree.js';
import { startLane, OR_CHAT_COMPLETIONS_URL } from '../proxy/lane.js';
import { runSession, taskFileInWorktree } from './subprocess.js';
import { RunEventBus, type SessionKey, type CellUpdate, type CellState } from './event-bus.js';
import { JudgeWorkerPool } from '../judge/worker.js';
import { captureGitDiff, type GitDiffSummary } from '../judge/git-diff.js';
import { printRunSummary } from './print-summary.js';
import { generate as generateReport } from '../report/generate.js';

// Per-lane timeout ceiling from SPEC §13.4. Defaults to 6 min; per-lane overrides
// come in a later milestone (D5+).
export const DEFAULT_SESSION_TIMEOUT_MS = 6 * 60 * 1000;

export interface LaneSpec {
  modelSlug: string;
  destinationSlug: string;
  router: string;
  providerTag: string | null;
  endpoint: OrEndpoint | null;
  fallbackModelPrice: { input: number; output: number } | null;
  // A5 additions — populated by store.startRun (A6). Optional here so
  // pre-A6 callers still typecheck; the orchestrator falls back to OR
  // defaults when a field is absent.
  /** Chat-completions URL for this lane. Defaults to OR when unset. */
  forwardUrl?: string;
  /** Bearer token for this lane's provider. Defaults to spec.orKey when unset. */
  apiKey?: string;
  /**
   * Provider-native model slug to put on the wire — may differ from
   * `modelSlug` (which stays canonical for DB / reporting). Defaults to
   * `modelSlug` when unset.
   */
  modelSlugForForward?: string;
  /**
   * Run-wide sampling pins. When set, lane.ts forces these fields onto the
   * outbound body, overriding whatever the subprocess sent. Enables
   * fair-fight comparisons where all providers sample from the same
   * (temperature, seed) policy.
   */
  pinTemperature?: number;
  pinSeed?: number;
}

export interface TaskSpec {
  id: string;
  file: string;                 // repo-relative path
  summary?: string;
  usesLlm?: boolean;
}

export interface RunSpec {
  runId: string;
  targetDir: string;
  configDir: string;
  parallelism: number;
  repeats: number;
  maxSpend: number;
  lanes: LaneSpec[];
  tasks: TaskSpec[];
  orKey: string;
  runnerCmd: string;
  sessionTimeoutMs?: number;
  /** Optional OR key for the judge (separate from the runner's key). Falls back to orKey. */
  judgeKey?: string;
  /** Set true to skip the judge entirely (used by tests that don't want to pay for Haiku). */
  disableJudge?: boolean;
  /**
   * Emit the ASCII run summary to stdout on completion. Defaults to true.
   * TUI callers (Ink is mounted on stdout) must set this false and use
   * `c1 runs summary <runId>` (or a bus subscription) for post-run review.
   */
  printSummary?: boolean;
  /** Redirect the printed summary to a custom stream (used by tests). */
  summaryStream?: NodeJS.WritableStream;
  /**
   * Auto-generate the HTML report at end of run. Defaults to true. Tests that
   * don't want the ~100-300 ms overhead can set false; the report is still
   * regenerable via `c1 runs report <runId>`.
   */
  generateReport?: boolean;
}

export interface RunResult {
  runId: string;
  totalSessions: number;
  passed: number;
  failed: number;
  aborted: number;
  totalCostUsd: number;
  dbPath: string;
  trafficLogPath: string;
}

export class RunEngine {
  readonly bus = new RunEventBus();
  private aborted = false;
  private activeKills = new Set<() => void>();

  async run(spec: RunSpec): Promise<RunResult> {
    await gcOldWorktrees(spec.configDir).catch(() => 0);

    const startedAt = new Date().toISOString();
    const db = new Db(path.join(spec.configDir, DB_FILE_NAME));
    const log = await openTrafficLog(spec.configDir, spec.runId);

    // Snapshot the run into runs table + meta.json.
    const meta: RunMeta = {
      runId: spec.runId,
      startedAt,
      targetDir: spec.targetDir,
      configDir: spec.configDir,
      parallelism: spec.parallelism,
      repeats: spec.repeats,
      lanes: spec.lanes.map((l) => ({ model: l.modelSlug, destination: l.destinationSlug, router: l.router })),
      tasks: spec.tasks.map((t) => ({ id: t.id, file: t.file })),
    };
    await writeRunMeta(spec.configDir, spec.runId, meta);
    await ensureGitignore(spec.targetDir, spec.configDir).catch(() => { /* non-fatal */ });
    db.insertRun({
      id: spec.runId, started_at: startedAt, finished_at: null,
      status: 'running', target_dir: spec.targetDir,
      meta_json: JSON.stringify(meta),
    });

    await log.append({
      ts: startedAt, kind: 'session-start',
      run_id: spec.runId, session_id: null, step_id: null, step_ix: null,
      note: 'run started',
    });

    // Deps cache once per run — every session symlinks into the same node_modules.
    const deps = await ensureDepsCache({ targetDir: spec.targetDir, configDir: spec.configDir })
      .catch((e) => { throw new Error(`deps install failed: ${e instanceof Error ? e.message : String(e)}`); });

    // Persist task summaries so the report + downstream tools can render
    // "what this test does" alongside the file path. Safe to re-run (upsert).
    for (const t of spec.tasks) {
      try { db.upsertTaskMeta(t.id, t.file, t.summary ?? null, !!t.usesLlm); }
      catch { /* non-fatal — tasks_meta is best-effort metadata */ }
    }

    // Materialize all (task × lane × repeat) sessions up front so LiveProgress
    // sees the full matrix as 'queued' immediately.
    const sessions = expandSessions(spec);

    this.bus.emit('run:started', {
      runId: spec.runId, targetDir: spec.targetDir, totalSessions: sessions.length,
    });
    for (const s of sessions) {
      db.insertSession({
        id: s.sessionId, run_id: spec.runId, task_id: s.task.id, task_file: s.task.file,
        model_slug: s.lane.modelSlug, destination_slug: s.lane.destinationSlug,
        router: s.lane.router, repeat_ix: s.repeatIx, status: 'queued',
        started_at: startedAt, finished_at: null, cost_usd: 0,
        verify_exit_code: null, verify_stdout_tail: null, verify_stderr_tail: null,
        failure_class: null, worktree_path: null, proxy_port: null,
      });
      this.bus.emit('session:queued', queuedUpdate(s));
    }

    const timeoutMs = spec.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    let passed = 0, failed = 0, aborted = 0, totalCost = 0;

    // Judge worker pool — runs alongside the runner, drains before run:complete.
    const judgeKey = spec.judgeKey ?? process.env.OR_JUDGE_KEY ?? spec.orKey;
    const judgeEnabled = !spec.disableJudge && !!judgeKey;
    const judgePool = judgeEnabled ? new JudgeWorkerPool({ db, bus: this.bus, concurrency: 3 }) : null;

    const parallelism = Math.max(1, Math.min(spec.parallelism, 16));
    let cursor = 0;
    const worker = async () => {
      while (true) {
        if (this.aborted) return;
        if (totalCost >= spec.maxSpend) return;
        const idx = cursor++;
        if (idx >= sessions.length) return;
        const s = sessions[idx];
        const outcome = await this.runOne(s, spec, db, log, deps, timeoutMs);
        totalCost += outcome.costUsd;
        if (outcome.state === 'passed') passed++;
        else if (outcome.state === 'failed' || outcome.state === 'error') failed++;
        else if (outcome.state === 'aborted') aborted++;

        if (judgePool && (outcome.state === 'passed' || outcome.state === 'failed' || outcome.state === 'error')) {
          judgePool.enqueue({
            sessionId: s.sessionId,
            key: sessionKey(s),
            context: {
              jsonlPath: log.path,
              gitDiff: outcome.gitDiff ?? { files_changed: 0, insertions: 0, deletions: 0, paths: [], is_git: false },
              orKey: judgeKey,
              verifyExitCode: outcome.verifyExitCode,
              testFile: s.task.file,
              taskId: s.task.id,
            },
          });
        }
      }
    };

    const workers = Array.from({ length: Math.min(parallelism, sessions.length) }, () => worker());
    await Promise.all(workers);

    // All sessions finished. Flip the visible state RIGHT NOW so the TUI's
    // title changes to "Run complete" without waiting on the judge's trailing
    // Haiku calls (the drain below can add several seconds for large runs).
    if (!this.aborted) {
      this.bus.emit('run:sessionsComplete', {
        runId: spec.runId, targetDir: spec.targetDir,
        totalSessions: sessions.length, totalCost,
      });
    }

    if (judgePool) await judgePool.drain();

    const finishedAt = new Date().toISOString();
    const status: SessionStatus = this.aborted ? 'aborted' : 'complete';
    db.updateRunStatus(spec.runId, status, finishedAt);

    // Emit the ASCII run summary. Default on; TUI callers explicitly disable
    // so it doesn't collide with Ink's alternate-screen output.
    if (spec.printSummary !== false && !this.aborted) {
      try { printRunSummary(spec.runId, spec.configDir, { stream: spec.summaryStream }); }
      catch { /* summary is best-effort; don't fail the run */ }
    }

    // Generate the HTML report. Fires 'report:generating' so LiveProgress can
    // show a "generating…" indicator; 'report:generated' when the path is
    // ready. Non-fatal on failure: run still emits 'run:complete'.
    if (spec.generateReport !== false && !this.aborted) {
      this.bus.emit('report:generating', {
        runId: spec.runId, targetDir: spec.targetDir, totalSessions: sessions.length,
      });
      try {
        const reportPath = await generateReport(spec.runId, spec.configDir);
        this.bus.emit('report:generated', {
          runId: spec.runId, targetDir: spec.targetDir,
          totalSessions: sessions.length, path: reportPath,
        });
      } catch (e) {
        this.bus.emit('report:failed', {
          runId: spec.runId, targetDir: spec.targetDir, totalSessions: sessions.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    await log.append({
      ts: finishedAt, kind: 'session-end',
      run_id: spec.runId, session_id: null, step_id: null, step_ix: null,
      note: `run ${status}`,
    });
    await log.close();
    db.close();

    if (this.aborted) {
      this.bus.emit('run:aborted', {
        runId: spec.runId, targetDir: spec.targetDir,
        totalSessions: sessions.length, reason: 'user_abort',
      });
    } else {
      this.bus.emit('run:complete', {
        runId: spec.runId, targetDir: spec.targetDir,
        totalSessions: sessions.length, totalCost,
      });
    }

    return {
      runId: spec.runId,
      totalSessions: sessions.length,
      passed, failed, aborted,
      totalCostUsd: totalCost,
      dbPath: db.path,
      trafficLogPath: log.path,
    };
  }

  abort(): void {
    this.aborted = true;
    for (const k of this.activeKills) { try { k(); } catch { /* ignore */ } }
  }

  private async runOne(
    s: PlannedSession,
    spec: RunSpec,
    db: Db,
    log: TrafficLog,
    deps: Awaited<ReturnType<typeof ensureDepsCache>>,
    timeoutMs: number,
  ): Promise<{ state: CellState; costUsd: number; verifyExitCode: number | null; gitDiff?: GitDiffSummary }> {
    const startedAt = new Date().toISOString();
    db.updateSession(s.sessionId, { status: 'running', started_at: startedAt });

    let worktree: Awaited<ReturnType<typeof createWorktree>> | null = null;
    let laneServer: Awaited<ReturnType<typeof startLane>> | null = null;
    let killer: (() => void) | null = null;
    try {
      worktree = await createWorktree({
        targetDir: spec.targetDir, configDir: spec.configDir,
        runId: spec.runId, sessionId: s.sessionId,
      });
      await symlinkNodeModules(worktree.path, deps);

      laneServer = await startLane(
        {
          runId: spec.runId, sessionId: s.sessionId,
          modelSlug: s.lane.modelSlug,
          modelSlugForForward: s.lane.modelSlugForForward ?? s.lane.modelSlug,
          destinationSlug: s.lane.destinationSlug,
          router: s.lane.router, providerTag: s.lane.providerTag,
          endpoint: s.lane.endpoint,
          fallbackModelPrice: s.lane.fallbackModelPrice,
          // Pre-A6 lanes (built by store.startRun without multi-router
          // awareness) leave these fields unset; fall back to OR so
          // existing single-router runs keep working unchanged.
          forwardUrl: s.lane.forwardUrl ?? OR_CHAT_COMPLETIONS_URL,
          apiKey: s.lane.apiKey ?? spec.orKey,
          pinTemperature: s.lane.pinTemperature,
          pinSeed: s.lane.pinSeed,
          onStep: (delta) => {
            this.bus.emit('session:step', {
              key: sessionKey(s),
              stepIx: delta.stepIx,
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
              costUsd: delta.costUsd,
              latencyMs: delta.latencyMs,
            });
          },
        },
        log, db,
      );

      db.updateSession(s.sessionId, { worktree_path: worktree.path, proxy_port: laneServer.port });
      this.bus.emit('session:running', runningUpdate(s, 0, laneServer.port));

      const taskFileAbs = taskFileInWorktree(worktree.path, s.task.file);
      // Verify task file exists in the worktree (helpful early failure signal).
      try { await fsp.access(taskFileAbs); }
      catch {
        throw new Error(`task file not found in worktree: ${s.task.file}`);
      }

      const { promise, kill } = runSession({
        runnerCmd: spec.runnerCmd,
        taskFile: s.task.file,
        cwd: worktree.path,
        proxyPort: laneServer.port,
        runId: spec.runId, sessionId: s.sessionId,
        lane: s.laneKey, orKey: spec.orKey,
        timeoutMs,
      });
      killer = () => kill('user_killed');
      this.activeKills.add(killer);
      const sub = await promise;
      this.activeKills.delete(killer);
      killer = null;

      const finishedAt = new Date().toISOString();
      const cost = laneServer.costUsd;
      const passed = sub.exitCode === 0 && !sub.failureClass;
      const cellState: CellState = sub.failureClass === 'user_killed' ? 'aborted'
        : passed ? 'passed'
          : sub.exitCode === null ? 'error'
            : 'failed';
      const finalStatus: SessionStatus =
        cellState === 'passed' ? 'complete'
          : cellState === 'aborted' ? 'aborted'
            : 'failed';

      db.updateSession(s.sessionId, {
        status: finalStatus, finished_at: finishedAt, cost_usd: cost,
        verify_exit_code: sub.exitCode,
        verify_stdout_tail: sub.stdoutTail.slice(-4096),
        verify_stderr_tail: sub.stderrTail.slice(-4096),
        failure_class: sub.failureClass,
      });

      const update: CellUpdate = {
        key: sessionKey(s), state: cellState,
        costUsd: cost, latencyMs: sub.durationMs,
        stepCount: laneServer.stepCount,
        inputTokens: laneServer.inputTokens,
        outputTokens: laneServer.outputTokens,
        verifyExitCode: sub.exitCode,
        failureClass: sub.failureClass,
      };
      this.bus.emit(cellState === 'passed' ? 'session:complete' : 'session:failed', update);

      await writeSessionMarkdown(spec.configDir, spec.runId, s.sessionId,
        renderSessionMd(s, sub, cost, laneServer.stepCount, cellState, laneServer.port));

      // Capture git diff BEFORE the finally-cleanup wipes the worktree.
      // Best-effort — non-fatal if git isn't available or the worktree is shallow.
      let gitDiff: GitDiffSummary | undefined;
      try { gitDiff = await captureGitDiff(worktree.path); }
      catch { /* leave undefined; judge falls back to zeros */ }

      return { state: cellState, costUsd: cost, verifyExitCode: sub.exitCode, gitDiff };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      const finishedAt = new Date().toISOString();
      db.updateSession(s.sessionId, {
        status: 'failed', finished_at: finishedAt,
        failure_class: 'setup_error',
        verify_stderr_tail: err.slice(-4096),
      });
      this.bus.emit('session:failed', {
        key: sessionKey(s), state: 'error',
        costUsd: 0, latencyMs: 0, stepCount: 0,
        inputTokens: 0, outputTokens: 0,
        verifyExitCode: null, failureClass: 'setup_error',
      });
      return { state: 'error', costUsd: 0, verifyExitCode: null };
    } finally {
      if (killer) this.activeKills.delete(killer);
      try { await laneServer?.close(); } catch { /* ignore */ }
      try { await worktree?.cleanup(); } catch { /* ignore */ }
    }
  }
}

// ---------- helpers ----------

interface PlannedSession {
  sessionId: string;
  task: TaskSpec;
  lane: LaneSpec;
  laneKey: string;
  repeatIx: number;
}

function expandSessions(spec: RunSpec): PlannedSession[] {
  const out: PlannedSession[] = [];
  for (const task of spec.tasks) {
    for (const lane of spec.lanes) {
      for (let r = 0; r < spec.repeats; r++) {
        out.push({
          sessionId: randomUUID(),
          task, lane,
          laneKey: `${lane.modelSlug}@${lane.destinationSlug}`,
          repeatIx: r,
        });
      }
    }
  }
  return out;
}

function sessionKey(s: PlannedSession): SessionKey {
  return { sessionId: s.sessionId, taskId: s.task.id, laneKey: s.laneKey, repeatIx: s.repeatIx };
}

function queuedUpdate(s: PlannedSession): CellUpdate {
  return { key: sessionKey(s), state: 'queued', costUsd: 0, latencyMs: 0, stepCount: 0, inputTokens: 0, outputTokens: 0 };
}

function runningUpdate(s: PlannedSession, cost: number, port: number): CellUpdate {
  return { key: sessionKey(s), state: 'running', costUsd: cost, latencyMs: 0, stepCount: 0, inputTokens: 0, outputTokens: 0, verifyExitCode: null };
}

function renderSessionMd(
  s: PlannedSession,
  sub: Awaited<ReturnType<typeof runSession>['promise']>,
  costUsd: number,
  steps: number,
  cellState: CellState,
  port: number,
): string {
  const bulletState = cellState === 'passed' ? '✓ passed' : cellState === 'aborted' ? '⊘ aborted' : '✗ ' + cellState;
  return [
    `# Session ${s.sessionId}`,
    ``,
    `- Task: \`${s.task.id}\` — \`${s.task.file}\``,
    `- Lane: \`${s.lane.modelSlug}\` @ \`${s.lane.destinationSlug}\``,
    `- Router: \`${s.lane.router}\``,
    `- Repeat: ${s.repeatIx}`,
    `- Verdict: **${bulletState}**  (exit=${sub.exitCode ?? 'null'}${sub.failureClass ? `, ${sub.failureClass}` : ''})`,
    `- Steps: ${steps}`,
    `- Cost: $${costUsd.toFixed(6)}`,
    `- Duration: ${sub.durationMs}ms`,
    `- Proxy port: ${port}`,
    ``,
    `## stdout (tail)`,
    ``,
    '```',
    sub.stdoutTail.trim() || '(empty)',
    '```',
    ``,
    `## stderr (tail)`,
    ``,
    '```',
    sub.stderrTail.trim() || '(empty)',
    '```',
    ``,
  ].join('\n');
}

// ---------- entry point convenience ----------

/**
 * One-shot helper: assembles a RunSpec from the store snapshot + starts a
 * RunEngine. Returns the engine + result promise so LiveProgress can subscribe.
 */
export interface RunFromStoreOpts {
  config: Config;
  configDir: string;
  targetDir: string;
  runnerCmd: string;
  parallelism: number;
  repeats: number;
  maxSpend: number;
  laneSpecs: LaneSpec[];
  tasks: TaskSpec[];
  orCatalog: OrCatalog | null;
}

export async function planRunFromStore(opts: RunFromStoreOpts): Promise<{ engine: RunEngine; spec: RunSpec }> {
  const detected = await detectOrKey();
  if (!detected.value) throw new Error('No OpenRouter key available for run.');
  const runId = randomUUID();
  const spec: RunSpec = {
    runId,
    targetDir: opts.targetDir,
    configDir: opts.configDir,
    parallelism: opts.parallelism,
    repeats: opts.repeats,
    maxSpend: opts.maxSpend,
    lanes: opts.laneSpecs,
    tasks: opts.tasks,
    orKey: detected.value,
    runnerCmd: opts.runnerCmd,
  };
  return { engine: new RunEngine(), spec };
}
