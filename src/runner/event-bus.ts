// In-process pub/sub used to drive LiveProgress from the run orchestrator.
// Kept intentionally tiny — Node's EventEmitter is fine, but a typed wrapper
// makes callsites clearer at the screen layer.

export interface SessionKey {
  sessionId: string;
  taskId: string;
  laneKey: string;   // "<model>@<destSlug>"
  repeatIx: number;
}

export type CellState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'error'
  | 'aborted';

export interface CellUpdate {
  key: SessionKey;
  state: CellState;
  costUsd: number;
  latencyMs: number;
  stepCount: number;
  inputTokens: number;
  outputTokens: number;
  verifyExitCode?: number | null;
  failureClass?: string | null;
}

export interface StepUpdate {
  key: SessionKey;
  stepIx: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface RunEvent {
  runId: string;
  targetDir: string;
  totalSessions: number;
}

export interface JudgeUpdate {
  key: SessionKey;
  outcome: 'success' | 'failure' | 'uncertain';
  trajectoryScore: number;         // 0..100
  action: number;                  // 0..25
  grounding: number;               // 0..25
  verification: number;            // 0..25
  efficiency: number;              // 0..25
  judgeOk: boolean;
}

export type EventMap = {
  'run:started':          RunEvent;
  /**
   * All runOne workers exited but the judge worker pool may still be draining.
   * Fires BEFORE 'run:complete' so the TUI can flip the title immediately
   * instead of waiting on the judge's trailing Haiku calls.
   */
  'run:sessionsComplete': RunEvent & { totalCost: number };
  /** HTML report generation started (post-judge-drain, pre-run:complete). */
  'report:generating':    RunEvent;
  /** HTML report finished writing; carries absolute path. */
  'report:generated':     RunEvent & { path: string };
  /** HTML report failed to generate; non-fatal — run:complete still fires. */
  'report:failed':        RunEvent & { error: string };
  'run:complete':         RunEvent & { totalCost: number };
  'run:aborted':          RunEvent & { reason: string };
  'session:queued':       CellUpdate;
  'session:running':      CellUpdate;
  'session:step':         StepUpdate;
  'session:complete':     CellUpdate;
  'session:failed':       CellUpdate;
  'session:judged':       JudgeUpdate;
};

type Listener<K extends keyof EventMap> = (payload: EventMap[K]) => void;

export class RunEventBus {
  private listeners = new Map<keyof EventMap, Set<Listener<any>>>();

  on<K extends keyof EventMap>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(cb as Listener<any>);
    return () => { set!.delete(cb as Listener<any>); };
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try { cb(payload); } catch { /* subscriber errors don't take down the bus */ }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
