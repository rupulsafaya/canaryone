import { create } from 'zustand';
import { TASKS, ALL_MODELS, Task, Cell, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, P50_RUN_SECONDS, getDestinations, isDestinationAvailable } from '../data/fixtures.js';
import type { Config, ORKeySource, OrCatalog } from '../data/schema.js';
import type { DeterministicScan } from '../scan/deterministic.js';
import type { MatchedFile } from '../scan/glob.js';
import { loadOrCatalog, fetchModelEndpoints, readCachedEndpoints } from '../scan/or-catalog.js';
import { detectOrKey, writeConfig } from './../scan/orchestrator.js';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';
export type EndpointStatus = 'idle' | 'loading' | 'ready' | 'error';

export type Screen = 'keySetup' | 'onboarding' | 'summarizeTasks' | 'pickTasks' | 'taskDetail' | 'pickModels' | 'pickDestinations' | 'confirm' | 'liveProgress';

// A lane = one (model, destination) tuple we test. Each lane is a row in LiveProgress.
// Destination slug already encodes (router, provider), so lane key = `${modelSlug}@${destSlug}`.
export type LaneKey = string;
export const laneKey = (model: string, dest: string): LaneKey => `${model}@${dest}`;
export const parseLane = (key: LaneKey): { model: string; dest: string } => {
  const at = key.indexOf('@');
  return { model: key.slice(0, at), dest: key.slice(at + 1) };
};

type State = {
  screen: Screen;
  cwd: string;
  targetDir: string;
  configDir: string;
  forceRescan: boolean;
  scanResult: DeterministicScan | null;
  config: Config | null;
  orKeyPresent: boolean;
  orKeySource: ORKeySource | null;
  matchedFiles: MatchedFile[];
  orCatalog: OrCatalog | null;
  orCatalogStatus: CatalogStatus;
  orCatalogError: string | null;
  endpointStatusBySlug: Record<string, EndpointStatus>;
  endpointErrorBySlug: Record<string, string>;
  onboardingStep: number;
  tasks: Task[];
  selectedModels: Set<string>;                            // model slugs
  selectedDestinations: Record<string, Set<string>>;      // modelSlug -> Set<destSlug>
  repeats: number;
  parallelism: number;
  maxSpend: number;
  focusedTaskId: string | null;
  cells: Record<LaneKey, Record<string, Cell>>;           // lane -> task.id -> cell
  runStartedAt: number | null;
  runFinishedAt: number | null;
  totalSpend: number;
  reportPath: string | null;
  goTo: (screen: Screen) => void;
  setScanResult: (r: DeterministicScan) => void;
  setConfig: (c: Config) => void;
  setOrKey: (present: boolean, source: ORKeySource | null) => void;
  setMatchedFiles: (files: MatchedFile[]) => void;
  loadCatalog: (force?: boolean) => Promise<void>;
  loadEndpointsFor: (slugs: string[], force?: boolean) => Promise<void>;
  persistTaskSelection: () => Promise<void>;
  applyConfigToTasks: () => void;
  toggleTask: (id: string) => void;
  selectAllTasks: (v: boolean) => void;
  toggleModel: (slug: string) => void;
  toggleDestination: (modelSlug: string, destSlug: string) => void;
  setFocusedTask: (id: string | null) => void;
  setMaxSpend: (v: number) => void;
  setParallelism: (v: number) => void;
  setRepeats: (v: number) => void;
  lanes: () => LaneKey[];
  startRun: () => void;
  tick: () => void;
  reset: () => void;
};

// When a model is toggled ON, auto-select a default destination:
//   1) an AVAILABLE first-party destination if present
//   2) else the first AVAILABLE destination
//   3) else the first destination (probably a preview, user will see it flagged)
function defaultDestinationFor(modelSlug: string): Set<string> {
  const destinations = getDestinations(modelSlug);
  if (!destinations.length) return new Set();
  const availableFirstParty = destinations.find((d) => d.isFirstParty && isDestinationAvailable(d));
  if (availableFirstParty) return new Set([availableFirstParty.slug]);
  const anyAvailable = destinations.find(isDestinationAvailable);
  if (anyAvailable) return new Set([anyAvailable.slug]);
  return new Set([destinations[0].slug]);
}

export const useStore = create<State>((set, get) => ({
  screen: 'keySetup',
  cwd: process.cwd(),
  targetDir: process.cwd(),
  configDir: process.cwd() + '/.c1',
  forceRescan: false,
  scanResult: null,
  config: null,
  orKeyPresent: false,
  orKeySource: null,
  matchedFiles: [],
  orCatalog: null,
  orCatalogStatus: 'idle',
  orCatalogError: null,
  endpointStatusBySlug: {},
  endpointErrorBySlug: {},
  onboardingStep: 0,
  tasks: TASKS,
  selectedModels: new Set<string>(),
  selectedDestinations: {},
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
  setScanResult: (r) => set({ scanResult: r }),
  setConfig: (c) => { set({ config: c }); get().applyConfigToTasks(); },
  setOrKey: (present, source) => set({ orKeyPresent: present, orKeySource: source }),
  setMatchedFiles: (files) => set({ matchedFiles: files }),
  loadCatalog: async (force = false) => {
    const s = get();
    if (s.orCatalogStatus === 'loading') return;
    if (!force && s.orCatalogStatus === 'ready' && s.orCatalog) return;
    set({ orCatalogStatus: 'loading', orCatalogError: null });
    try {
      const detected = await detectOrKey();
      const { catalog } = await loadOrCatalog({ orKey: detected.value ?? null, force });
      set({ orCatalog: catalog, orCatalogStatus: 'ready', orCatalogError: null });
    } catch (e) {
      set({ orCatalogStatus: 'error', orCatalogError: e instanceof Error ? e.message : String(e) });
    }
  },
  loadEndpointsFor: async (slugs, force = false) => {
    const s = get();
    // Ensure catalog is ready so persistEndpoints has a file to write into.
    if (!s.orCatalog) await get().loadCatalog();
    const currentStatus = get().endpointStatusBySlug;

    // Filter which slugs actually need fetching.
    const toFetch: string[] = [];
    for (const slug of slugs) {
      if (currentStatus[slug] === 'loading') continue;
      const cached = readCachedEndpoints(get().orCatalog, slug);
      if (!force && cached) {
        set((st) => ({ endpointStatusBySlug: { ...st.endpointStatusBySlug, [slug]: 'ready' } }));
        continue;
      }
      toFetch.push(slug);
    }
    if (toFetch.length === 0) return;

    set((st) => {
      const next = { ...st.endpointStatusBySlug };
      for (const slug of toFetch) next[slug] = 'loading';
      return { endpointStatusBySlug: next };
    });

    await Promise.all(toFetch.map(async (slug) => {
      try {
        await fetchModelEndpoints(slug);   // persists into or-catalog.json
        // Reload catalog from cache to pick up the new endpoints map.
        const detected = await detectOrKey();
        const { catalog } = await loadOrCatalog({ orKey: detected.value ?? null });
        set((st) => ({
          orCatalog: catalog,
          endpointStatusBySlug: { ...st.endpointStatusBySlug, [slug]: 'ready' },
        }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set((st) => ({
          endpointStatusBySlug: { ...st.endpointStatusBySlug, [slug]: 'error' },
          endpointErrorBySlug: { ...st.endpointErrorBySlug, [slug]: msg },
        }));
      }
    }));
  },
  persistTaskSelection: async () => {
    const s = get();
    if (!s.config) return;
    const included = s.tasks.filter((t) => t.included).map((t) => t.file);
    const nextConfig = {
      ...s.config,
      tasks: { ...s.config.tasks, included },
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeConfig(s.configDir, nextConfig);
      set({ config: nextConfig });   // update in-memory without re-deriving tasks
    } catch {
      // Non-fatal — user's picks stay in-memory even if disk write fails.
    }
  },
  applyConfigToTasks: () => {
    const s = get();
    if (!s.config) return;
    const runnerCmd = s.config.runner.cmd;
    const includedSet = new Set(s.config.tasks.included);
    const hasSaved = s.config.tasks.included.length > 0;
    const summaries = s.config.tasks.summaries ?? {};
    const tasks: Task[] = s.matchedFiles.map((f, i) => {
      const sum = summaries[f.relative];
      return {
        id: 't' + String(i + 1).padStart(2, '0'),
        file: f.relative,
        name: f.relative.split('/').pop() ?? f.relative,
        summary: sum?.summary ?? f.relative,
        confidence: NaN,        // marker: no classifier ran for scan-sourced tasks
        verifyCmd: `${runnerCmd} ${f.relative}`,
        // No auto-select — user must space-toggle each test. Saved config
        // (if any) restores prior picks; otherwise start unchecked.
        included: hasSaved ? includedSet.has(f.relative) : false,
        source: 'scan',
        bullets: sum?.bullets,
        usesLLM: sum?.usesLLM,
        llmEvidence: sum?.llmEvidence,
      };
    });
    set({ tasks });
  },
  toggleTask: (id) => set((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, included: !t.included } : t)),
  })),
  selectAllTasks: (v) => set((s) => ({ tasks: s.tasks.map((t) => ({ ...t, included: v })) })),
  toggleModel: (slug) => set((s) => {
    const nextModels = new Set(s.selectedModels);
    const nextDests = { ...s.selectedDestinations };
    if (nextModels.has(slug)) {
      nextModels.delete(slug);
      delete nextDests[slug];
    } else {
      nextModels.add(slug);
      // No default destination — user must pick one on PickDestinations.
      if (!nextDests[slug]) nextDests[slug] = new Set<string>();
    }
    return { selectedModels: nextModels, selectedDestinations: nextDests };
  }),
  toggleDestination: (modelSlug, destSlug) => set((s) => {
    const cur = new Set(s.selectedDestinations[modelSlug] ?? []);
    if (cur.has(destSlug)) cur.delete(destSlug);
    else cur.add(destSlug);
    return { selectedDestinations: { ...s.selectedDestinations, [modelSlug]: cur } };
  }),
  setFocusedTask: (id) => set({ focusedTaskId: id }),
  setMaxSpend: (v) => set({ maxSpend: v }),
  setParallelism: (v) => set({ parallelism: Math.max(1, Math.min(32, Math.floor(v))) }),
  setRepeats: (v) => set({ repeats: Math.max(1, Math.min(20, Math.floor(v))) }),
  lanes: () => {
    const s = get();
    const out: LaneKey[] = [];
    for (const model of s.selectedModels) {
      const dests = s.selectedDestinations[model] ?? new Set<string>();
      for (const dest of dests) out.push(laneKey(model, dest));
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

    for (const lane of lanes) {
      const { model, dest } = parseLane(lane);
      const modelObj = ALL_MODELS.find((m) => m.slug === model);
      const destObj = getDestinations(model).find((d) => d.slug === dest);
      if (!modelObj) continue;
      const inPrice = destObj?.inputPrice ?? modelObj.inputPrice;
      const outPrice = destObj?.outputPrice ?? modelObj.outputPrice;

      const laneCells = { ...cells[lane] };
      let running = includedTasks.find((t) => laneCells[t.id].state === 'running');
      if (!running) {
        const next = includedTasks.find((t) => laneCells[t.id].state === 'queued');
        if (next) laneCells[next.id] = { state: 'running', costUsd: 0, latencyMs: 0 };
      } else {
        const inputCost = (BASELINE_INPUT_TOKENS / 1_000_000) * inPrice;
        const outputCost = (BASELINE_OUTPUT_TOKENS / 1_000_000) * outPrice;
        const cost = inputCost + outputCost + JUDGE_COST_PER_TASK;
        const h = (lane + running.id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const outcome: 'passed' | 'failed' | 'error' =
          h % 13 === 0 ? 'error' : h % 7 === 0 ? 'failed' : 'passed';
        laneCells[running.id] = { state: outcome, costUsd: cost, latencyMs: P50_RUN_SECONDS * 1000 };
        totalSpend += cost;
      }
      cells[lane] = laneCells;
    }

    const done = lanes.every((lane) =>
      includedTasks.every((t) => {
        const st = cells[lane][t.id].state;
        return st === 'passed' || st === 'failed' || st === 'error';
      })
    );
    set({ cells, totalSpend, runFinishedAt: done ? Date.now() : null });
  },
  reset: () => set({
    screen: 'keySetup',
    onboardingStep: 0,
    cells: {},
    runStartedAt: null,
    runFinishedAt: null,
    totalSpend: 0,
    reportPath: null,
  }),
}));
