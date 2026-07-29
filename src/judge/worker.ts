// JudgeWorkerPool — runs judgeSession() in parallel with the runner.
// Concurrency defaults to 3 (SPEC §13). When a session terminates, the
// orchestrator enqueues a judge job with a pre-captured gitDiff (so the
// worktree is still around to inspect). Verdicts are written to
// classifier_tags and emitted on the event bus as 'session:judged'.

import type { Db } from '../db/sqlite.js';
import type { RunEventBus, SessionKey } from '../runner/event-bus.js';
import {
  judgeSession,
  verdictToTags,
  JUDGE_CLASSIFIER_META,
  type JudgeContext,
  type Verdict,
} from './haiku-r5.js';

export interface JudgeJob {
  sessionId: string;
  key: SessionKey;
  context: JudgeContext;
}

export interface JudgeWorkerPoolOpts {
  concurrency?: number;
  db: Db;
  bus?: RunEventBus;
  /**
   * When true, skip the actual LLM call and write a fallback verdict.
   * Used by CI where an OR_JUDGE_KEY isn't available, and by tests that
   * want to exercise the write path without paying for a Haiku call.
   */
  offline?: boolean;
}

export class JudgeWorkerPool {
  private readonly queue: JudgeJob[] = [];
  private readonly workers: Promise<void>[] = [];
  private readonly concurrency: number;
  private readonly db: Db;
  private readonly bus: RunEventBus | undefined;
  private readonly offline: boolean;
  private closed = false;
  private idleResolvers: Array<() => void> = [];

  constructor(opts: JudgeWorkerPoolOpts) {
    this.concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 8));
    this.db = opts.db;
    this.bus = opts.bus;
    this.offline = !!opts.offline;
    for (let i = 0; i < this.concurrency; i++) {
      this.workers.push(this.workerLoop());
    }
  }

  enqueue(job: JudgeJob): void {
    if (this.closed) return;   // draining — reject silently
    this.queue.push(job);
  }

  async drain(): Promise<void> {
    this.closed = true;
    // Wake up idle workers so they can observe closed + empty queue and exit.
    for (const r of this.idleResolvers) r();
    this.idleResolvers = [];
    await Promise.all(this.workers);
  }

  private async workerLoop(): Promise<void> {
    while (true) {
      const job = this.queue.shift();
      if (!job) {
        if (this.closed) return;
        await new Promise<void>((resolve) => { this.idleResolvers.push(resolve); });
        continue;
      }
      await this.processOne(job).catch(() => { /* swallowed — never let worker die */ });
    }
  }

  private async processOne(job: JudgeJob): Promise<void> {
    let verdict: Verdict;
    if (this.offline) {
      const { fallbackVerdict } = await import('./haiku-r5.js');
      const { computeActionScore, computeEfficiencyScore } = await import('./subscores.js');
      const { loadSteps } = await import('./trajectory.js');
      const steps = await loadSteps(job.context.jsonlPath, job.sessionId);
      const action = computeActionScore(steps);
      const efficiency = computeEfficiencyScore(steps);
      verdict = fallbackVerdict(action, efficiency, job.context.verifyExitCode, 'offline mode');
    } else {
      verdict = await judgeSession(job.sessionId, job.context);
    }

    try {
      this.db.insertClassifierTags(job.sessionId, verdictToTags(verdict), JUDGE_CLASSIFIER_META);
    } catch (e) {
      // DB write is best-effort — SQLite can occasionally hit BUSY. Log via bus.
      const msg = e instanceof Error ? e.message : String(e);
      if (this.bus) this.bus.emit('session:judged', judgedUpdate(job.key, verdict));
      throw new Error(`insertClassifierTags failed: ${msg}`);
    }

    if (this.bus) this.bus.emit('session:judged', judgedUpdate(job.key, verdict));
  }
}

function judgedUpdate(key: SessionKey, v: Verdict) {
  return {
    key,
    outcome: v.outcome,
    trajectoryScore: v.trajectory_score,
    action: v.action,
    grounding: v.grounding,
    verification: v.verification,
    efficiency: v.efficiency,
    judgeOk: v.judge_ok,
  };
}
