import { create } from 'zustand';
import { TASKS, ALL_MODELS, Task, Model, Cell, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, P50_RUN_SECONDS } from '../data/fixtures.js';

export type Screen = 'onboarding' | 'pickTasks' | 'pickModels' | 'confirm' | 'liveProgress' | 'report';

type State = {
  screen: Screen;
  onboardingStep: number; // 0..3
  tasks: Task[];
  selectedModels: Set<string>;
  repeats: number;
  parallelism: number;
  maxSpend: number;
  cells: Record<string, Record<string, Cell>>; // model -> task -> cell
  runStartedAt: number | null;
  runFinishedAt: number | null;
  totalSpend: number;
  currentWork: string | null;
  goTo: (screen: Screen) => void;
  toggleTask: (id: string) => void;
  selectAllTasks: (v: boolean) => void;
  toggleModel: (slug: string) => void;
  setPreset: (slugs: string[]) => void;
  startRun: () => void;
  tick: () => void;
  reset: () => void;
};

export const useStore = create<State>((set, get) => ({
  screen: 'onboarding',
  onboardingStep: 0,
  tasks: TASKS,
  selectedModels: new Set(['anthropic/claude-haiku-4.5', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.2']),
  repeats: 3,
  parallelism: 3,
  maxSpend: 10,
  cells: {},
  runStartedAt: null,
  runFinishedAt: null,
  totalSpend: 0,
  currentWork: null,
  goTo: (screen) => set({ screen }),
  toggleTask: (id) => set((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, included: !t.included } : t)),
  })),
  selectAllTasks: (v) => set((s) => ({ tasks: s.tasks.map((t) => ({ ...t, included: v })) })),
  toggleModel: (slug) => set((s) => {
    const next = new Set(s.selectedModels);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    return { selectedModels: next };
  }),
  setPreset: (slugs) => set({ selectedModels: new Set(slugs) }),
  startRun: () => {
    const s = get();
    const includedTasks = s.tasks.filter((t) => t.included);
    const cells: Record<string, Record<string, Cell>> = {};
    for (const slug of s.selectedModels) {
      cells[slug] = {};
      for (const task of includedTasks) {
        cells[slug][task.id] = { state: 'queued', costUsd: 0, latencyMs: 0 };
      }
    }
    set({
      screen: 'liveProgress',
      cells,
      runStartedAt: Date.now(),
      runFinishedAt: null,
      totalSpend: 0,
      currentWork: null,
    });
  },
  tick: () => {
    const s = get();
    if (!s.runStartedAt || s.runFinishedAt) return;
    const includedTasks = s.tasks.filter((t) => t.included);
    const modelSlugs = Array.from(s.selectedModels);
    if (!modelSlugs.length || !includedTasks.length) return;

    const cells = { ...s.cells };
    let totalSpend = s.totalSpend;
    let anyRunning = false;
    let anyQueued = false;

    for (const slug of modelSlugs) {
      // Each model has a lane of `parallelism/models` = ~1 worker; do the next queued or advance the running one
      const modelCells = { ...cells[slug] };
      let running = includedTasks.find((t) => modelCells[t.id].state === 'running');
      if (!running) {
        const next = includedTasks.find((t) => modelCells[t.id].state === 'queued');
        if (next) {
          modelCells[next.id] = { state: 'running', costUsd: 0, latencyMs: 0 };
          anyRunning = true;
        }
      } else {
        // Complete it, roll fake outcome
        const model = ALL_MODELS.find((m) => m.slug === slug)!;
        const inputCost = (BASELINE_INPUT_TOKENS / 1_000_000) * model.inputPrice;
        const outputCost = (BASELINE_OUTPUT_TOKENS / 1_000_000) * model.outputPrice;
        const cost = inputCost + outputCost + JUDGE_COST_PER_TASK;
        // Deterministic-ish outcome based on hash
        const h = (slug + running.id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const outcome: 'passed' | 'failed' | 'error' =
          h % 13 === 0 ? 'error' : h % 7 === 0 ? 'failed' : 'passed';
        modelCells[running.id] = { state: outcome, costUsd: cost, latencyMs: P50_RUN_SECONDS * 1000 };
        totalSpend += cost;
        anyRunning = true;
      }
      cells[slug] = modelCells;
      if (includedTasks.some((t) => modelCells[t.id].state === 'queued' || modelCells[t.id].state === 'running')) {
        anyQueued = true;
      }
    }

    const runFinishedAt = !anyQueued && !anyRunning ? Date.now() : null;
    set({ cells, totalSpend, runFinishedAt });
  },
  reset: () => set({
    screen: 'onboarding',
    onboardingStep: 0,
    cells: {},
    runStartedAt: null,
    runFinishedAt: null,
    totalSpend: 0,
    currentWork: null,
  }),
}));
