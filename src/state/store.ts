import { create } from 'zustand';
import { TASKS, ALL_MODELS, Task, Cell, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, P50_RUN_SECONDS, getHosts } from '../data/fixtures.js';

export type Screen = 'onboarding' | 'pickTasks' | 'taskDetail' | 'pickModels' | 'pickHosts' | 'confirm' | 'liveProgress';

// A "lane" is one (model, host) tuple we run tasks against. Each lane is a row in LiveProgress.
export type LaneKey = string; // encoded as `${modelSlug}::${hostSlug}`
export const laneKey = (model: string, host: string): LaneKey => `${model}::${host}`;
export const parseLane = (key: LaneKey): { model: string; host: string } => {
  const [model, host] = key.split('::');
  return { model, host };
};

type State = {
  screen: Screen;
  cwd: string;
  onboardingStep: number; // 0..4
  tasks: Task[];
  selectedModels: Set<string>;                  // model slugs
  selectedHosts: Record<string, Set<string>>;   // modelSlug -> Set<hostSlug>
  repeats: number;
  parallelism: number;
  maxSpend: number;
  focusedTaskId: string | null;
  cells: Record<LaneKey, Record<string, Cell>>; // lane -> task.id -> cell
  runStartedAt: number | null;
  runFinishedAt: number | null;
  totalSpend: number;
  reportPath: string | null;
  goTo: (screen: Screen) => void;
  toggleTask: (id: string) => void;
  selectAllTasks: (v: boolean) => void;
  toggleModel: (slug: string) => void;
  toggleHost: (modelSlug: string, hostSlug: string) => void;
  setFocusedTask: (id: string | null) => void;
  setMaxSpend: (v: number) => void;
  lanes: () => LaneKey[];
  startRun: () => void;
  tick: () => void;
  reset: () => void;
};

// Auto-select the first host for a newly-selected model so there's always ≥1 lane.
function defaultHostsFor(modelSlug: string): Set<string> {
  const hosts = getHosts(modelSlug);
  return new Set(hosts.length ? [hosts[0].slug] : []);
}

export const useStore = create<State>((set, get) => ({
  screen: 'onboarding',
  cwd: process.cwd(),
  onboardingStep: 0,
  tasks: TASKS,
  selectedModels: new Set(['anthropic/claude-haiku-4.5', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.2']),
  selectedHosts: {
    'anthropic/claude-haiku-4.5': new Set(['anthropic']),
    'deepseek/deepseek-v4-flash': new Set(['baidu']),
    'z-ai/glm-5.2': new Set(['baseten/fp8']),
  },
  repeats: 3,
  parallelism: 3,
  maxSpend: 10,
  focusedTaskId: null,
  cells: {},
  runStartedAt: null,
  runFinishedAt: null,
  totalSpend: 0,
  reportPath: null,
  goTo: (screen) => set({ screen }),
  toggleTask: (id) => set((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, included: !t.included } : t)),
  })),
  selectAllTasks: (v) => set((s) => ({ tasks: s.tasks.map((t) => ({ ...t, included: v })) })),
  toggleModel: (slug) => set((s) => {
    const nextModels = new Set(s.selectedModels);
    const nextHosts = { ...s.selectedHosts };
    if (nextModels.has(slug)) {
      nextModels.delete(slug);
      delete nextHosts[slug];
    } else {
      nextModels.add(slug);
      if (!nextHosts[slug]) nextHosts[slug] = defaultHostsFor(slug);
    }
    return { selectedModels: nextModels, selectedHosts: nextHosts };
  }),
  toggleHost: (modelSlug, hostSlug) => set((s) => {
    const cur = new Set(s.selectedHosts[modelSlug] ?? []);
    if (cur.has(hostSlug)) cur.delete(hostSlug);
    else cur.add(hostSlug);
    return { selectedHosts: { ...s.selectedHosts, [modelSlug]: cur } };
  }),
  setFocusedTask: (id) => set({ focusedTaskId: id }),
  setMaxSpend: (v) => set({ maxSpend: v }),
  lanes: () => {
    const s = get();
    const out: LaneKey[] = [];
    for (const model of s.selectedModels) {
      const hosts = s.selectedHosts[model] ?? new Set<string>();
      for (const host of hosts) out.push(laneKey(model, host));
    }
    return out;
  },
  startRun: () => {
    const s = get();
    const includedTasks = s.tasks.filter((t) => t.included);
    const lanes = s.lanes();
    const cells: Record<LaneKey, Record<string, Cell>> = {};
    for (const lane of lanes) {
      cells[lane] = {};
      for (const task of includedTasks) {
        cells[lane][task.id] = { state: 'queued', costUsd: 0, latencyMs: 0 };
      }
    }
    // Mock a report path (real: written on completion)
    const stamp = '2026-07-28T09-30-00Z';
    set({
      screen: 'liveProgress',
      cells,
      runStartedAt: Date.now(),
      runFinishedAt: null,
      totalSpend: 0,
      reportPath: `.c1/reports/${stamp}/index.html`,
    });
  },
  tick: () => {
    const s = get();
    if (!s.runStartedAt || s.runFinishedAt) return;
    const includedTasks = s.tasks.filter((t) => t.included);
    const lanes = Object.keys(s.cells);
    if (!lanes.length || !includedTasks.length) return;

    const cells = { ...s.cells };
    let totalSpend = s.totalSpend;
    let anyActive = false;

    for (const lane of lanes) {
      const { model, host } = parseLane(lane);
      const modelObj = ALL_MODELS.find((m) => m.slug === model);
      const hostObj = getHosts(model).find((h) => h.slug === host);
      if (!modelObj) continue;
      const inPrice = hostObj?.inputPrice ?? modelObj.inputPrice;
      const outPrice = hostObj?.outputPrice ?? modelObj.outputPrice;

      const laneCells = { ...cells[lane] };
      let running = includedTasks.find((t) => laneCells[t.id].state === 'running');
      if (!running) {
        const next = includedTasks.find((t) => laneCells[t.id].state === 'queued');
        if (next) {
          laneCells[next.id] = { state: 'running', costUsd: 0, latencyMs: 0 };
          anyActive = true;
        }
      } else {
        const inputCost = (BASELINE_INPUT_TOKENS / 1_000_000) * inPrice;
        const outputCost = (BASELINE_OUTPUT_TOKENS / 1_000_000) * outPrice;
        const cost = inputCost + outputCost + JUDGE_COST_PER_TASK;
        const h = (lane + running.id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const outcome: 'passed' | 'failed' | 'error' =
          h % 13 === 0 ? 'error' : h % 7 === 0 ? 'failed' : 'passed';
        laneCells[running.id] = { state: outcome, costUsd: cost, latencyMs: P50_RUN_SECONDS * 1000 };
        totalSpend += cost;
        anyActive = true;
      }
      cells[lane] = laneCells;
      if (includedTasks.some((t) => laneCells[t.id].state === 'queued' || laneCells[t.id].state === 'running')) {
        anyActive = true;
      }
    }

    // Check terminal state: everything done means no queued and no running anywhere
    const done = lanes.every((lane) =>
      includedTasks.every((t) => {
        const st = cells[lane][t.id].state;
        return st === 'passed' || st === 'failed' || st === 'error';
      })
    );
    set({ cells, totalSpend, runFinishedAt: done ? Date.now() : null });
  },
  reset: () => set({
    screen: 'onboarding',
    onboardingStep: 0,
    cells: {},
    runStartedAt: null,
    runFinishedAt: null,
    totalSpend: 0,
    reportPath: null,
  }),
}));
