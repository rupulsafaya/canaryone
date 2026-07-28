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

export type EventMap = {
  'run:started':      RunEvent;
  'run:complete':     RunEvent & { totalCost: number };
  'run:aborted':      RunEvent & { reason: string };
  'session:queued':   CellUpdate;
  'session:running':  CellUpdate;
  'session:step':     StepUpdate;
  'session:complete': CellUpdate;
  'session:failed':   CellUpdate;
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
