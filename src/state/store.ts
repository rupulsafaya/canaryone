import { create } from 'zustand';
import { TASKS, ALL_MODELS, Task, Cell, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, P50_RUN_SECONDS, getDestinations, isDestinationAvailable } from '../data/fixtures.js';
import type { Config, MethodologyReport, ORKeySource, OrCatalog } from '../data/schema.js';
import type { DeterministicScan } from '../scan/deterministic.js';
import type { MatchedFile } from '../scan/glob.js';
import { loadOrCatalog, fetchModelEndpoints, readCachedEndpoints } from '../scan/or-catalog.js';
import { detectOrKey, writeConfig } from './../scan/orchestrator.js';
import { runMethodology, isMethodologyFresh } from '../scan/methodology.js';
import { RunEngine, type LaneSpec, type TaskSpec, type RunSpec } from '../runner/orchestrator.js';
import type { CellState as EngineCellState, CellUpdate, StepUpdate } from '../runner/event-bus.js';
import { randomUUID } from 'node:crypto';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';
export type EndpointStatus = 'idle' | 'loading' | 'ready' | 'error';
export type MethodologyStatus = 'idle' | 'loading' | 'ready' | 'blocked' | 'error';

export type Screen = 'keySetup' | 'onboarding' | 'summarizeTasks' | 'methodologyCheck' | 'pickTasks' | 'taskDetail' | 'pickModels' | 'pickDestinations' | 'confirm' | 'liveProgress';

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
  forceRescanMethodology: boolean;
  scanResult: DeterministicScan | null;
  config: Config | null;
  orKeyPresent: boolean;
  orKeySource: ORKeySource | null;
  matchedFiles: MatchedFile[];
  methodology: MethodologyReport | null;
  methodologyStatus: MethodologyStatus;
  methodologyError: string | null;
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
  totalInputTokens: number;
  totalOutputTokens: number;
  reportPath: string | null;
  reportHtmlPath: string | null;   // absolute path to report/index.html when generated
  reportGenerating: boolean;       // true between report:generating and report:generated/failed
  reportError: string | null;
  runId: string | null;
  runError: string | null;
  engine: RunEngine | null;
  goTo: (screen: Screen) => void;
  setScanResult: (r: DeterministicScan) => void;
  setConfig: (c: Config) => void;
  setOrKey: (present: boolean, source: ORKeySource | null) => void;
  setMatchedFiles: (files: MatchedFile[]) => void;
  loadMethodology: (force?: boolean) => Promise<void>;
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
  startRun: () => Promise<void>;
  abortRun: () => void;
  tick: () => void;                // legacy no-op (kept so LiveProgress imports don't break)
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
  forceRescanMethodology: false,
  scanResult: null,
  config: null,
  orKeyPresent: false,
  orKeySource: null,
  matchedFiles: [],
  methodology: null,
  methodologyStatus: 'idle',
  methodologyError: null,
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
  totalInputTokens: 0,
  totalOutputTokens: 0,
  reportPath: null,
  reportHtmlPath: null,
  reportGenerating: false,
  reportError: null,
  runId: null,
  runError: null,
  engine: null,
  goTo: (screen) => set({ screen }),
  setScanResult: (r) => set({ scanResult: r }),
  setConfig: (c) => { set({ config: c }); get().applyConfigToTasks(); },
  setOrKey: (present, source) => set({ orKeyPresent: present, orKeySource: source }),
  setMatchedFiles: (files) => set({ matchedFiles: files }),
  loadMethodology: async (force = false) => {
    const s = get();
    if (s.methodologyStatus === 'loading') return;
    // Cache: if config carries a fresh methodology and no rescan requested,
    // hydrate it into state without recomputing.
    if (!force && s.config?.methodology) {
      const fresh = await isMethodologyFresh(s.config.methodology, s.targetDir);
      if (fresh) {
        const state = s.config.methodology.state;
        const nextStatus: MethodologyStatus =
          state === 'sdk-env' || state === 'sdk-config' ? 'ready' : 'blocked';
        set({ methodology: s.config.methodology, methodologyStatus: nextStatus, methodologyError: null });
        return;
      }
    }
    if (!s.matchedFiles.length) {
      set({ methodologyStatus: 'error', methodologyError: 'No matched test files to scan.' });
      return;
    }
    set({ methodologyStatus: 'loading', methodologyError: null });
    try {
      const { report } = await runMethodology({
        testFiles: s.matchedFiles,
        targetDir: s.targetDir,
      });
      // Persist onto config.
      if (s.config) {
        const nextConfig = { ...s.config, methodology: report, updatedAt: new Date().toISOString() };
        try { await writeConfig(s.configDir, nextConfig); } catch { /* non-fatal */ }
        set({ config: nextConfig });
      }
      const nextStatus: MethodologyStatus =
        report.state === 'sdk-env' || report.state === 'sdk-config' ? 'ready' : 'blocked';
      set({ methodology: report, methodologyStatus: nextStatus, methodologyError: null });
    } catch (e) {
      set({
        methodologyStatus: 'error',
        methodologyError: e instanceof Error ? e.message : String(e),
      });
    }
  },
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
  startRun: async () => {
    const s = get();
    const includedTasks = s.tasks.filter((t) => t.included);
    const laneKeys = s.lanes();
    if (!includedTasks.length || !laneKeys.length) {
      set({ runError: 'No tasks or lanes selected — cannot start run.' });
      return;
    }
    if (!s.config) {
      set({ runError: 'Config not loaded — walk through onboarding first.' });
      return;
    }
    const detected = await detectOrKey();
    if (!detected.value) {
      set({ runError: 'No OpenRouter key available — cannot start run.' });
      return;
    }

    // Build LaneSpec[] from selected models × destinations, hydrating endpoint
    // metadata from the OR catalog so the proxy has pricing for cost math.
    // Fallback: model-level $/M from catalog.models[i] — used when the exact
    // endpoint lookup misses (e.g. providerTag drift between picker + catalog).
    const laneSpecs: LaneSpec[] = [];
    for (const key of laneKeys) {
      const { model: modelSlug, dest: destSlug } = parseLane(key);
      const endpoints = s.orCatalog?.endpointsBySlug?.[modelSlug]?.endpoints ?? [];
      const modelMeta = s.orCatalog?.models.find((m) => m.slug === modelSlug) ?? null;
      const [router, ...providerParts] = destSlug.split(':');
      const providerTag = providerParts.join(':') || null;
      const endpoint = endpoints.find((e) => e.providerTag === providerTag) ?? null;
      const fallbackModelPrice = modelMeta
        ? { input: modelMeta.inputPrice, output: modelMeta.outputPrice }
        : null;
      laneSpecs.push({
        modelSlug,
        destinationSlug: destSlug,
        router: router || 'openrouter',
        providerTag,
        endpoint,
        fallbackModelPrice,
      });
    }

    const taskSpecs: TaskSpec[] = includedTasks.map((t) => ({
      id: t.id, file: t.file, summary: t.summary, usesLlm: t.usesLLM ?? false,
    }));

    // Seed cells as queued so LiveProgress renders the full matrix immediately.
    const cells: Record<LaneKey, Record<string, Cell>> = {};
    for (const lane of laneKeys) {
      cells[lane] = {};
      for (const task of includedTasks) {
        cells[lane][task.id] = { state: 'queued', costUsd: 0, latencyMs: 0, passed: 0, attempted: 0 };
      }
    }

    const engine = new RunEngine();
    const spec: RunSpec = {
      runId: randomUUID(),
      targetDir: s.targetDir,
      configDir: s.configDir,
      parallelism: s.parallelism,
      repeats: s.repeats,
      maxSpend: s.maxSpend,
      lanes: laneSpecs,
      tasks: taskSpecs,
      orKey: detected.value,
      runnerCmd: s.config.runner.cmd,
      // Ink owns stdout while LiveProgress is rendered — the summary would
      // interleave with the alternate-screen buffer. Post-run review goes
      // through `c1 runs summary <runId>` (headless-only) instead.
      printSummary: false,
    };

    engine.bus.on('session:running', (u) => applyCellUpdate(u));
    engine.bus.on('session:complete', (u) => applyCellUpdate(u));
    engine.bus.on('session:failed', (u) => applyCellUpdate(u));
    // Live per-request updates so the subtitle ($ / tokens) advances during
    // a run instead of jumping only when a session completes. session:step
    // deltas are additive; state changes stay on the session:* events.
    engine.bus.on('session:step', (u) => applyStepUpdate(u));
    // 'run:sessionsComplete' fires as soon as all runOne workers exit; the
    // judge pool may still be draining in the background. Flip the visible
    // state now so the title doesn't sit on "Running" for the judge tail.
    // 'run:complete' still fires later (after drain); we clear the engine
    // handle then so any late abort is a no-op.
    engine.bus.on('run:sessionsComplete', () => {
      set({ runFinishedAt: Date.now() });
    });
    engine.bus.on('run:complete', () => {
      set({ runFinishedAt: Date.now(), engine: null });
    });
    engine.bus.on('run:aborted', () => {
      set({ runFinishedAt: Date.now(), engine: null });
    });
    engine.bus.on('report:generating', () => set({ reportGenerating: true }));
    engine.bus.on('report:generated', (u) => set({
      reportGenerating: false, reportHtmlPath: u.path, reportError: null,
    }));
    engine.bus.on('report:failed', (u) => set({
      reportGenerating: false, reportHtmlPath: null, reportError: u.error,
    }));

    set({
      screen: 'liveProgress',
      cells,
      runStartedAt: Date.now(),
      runFinishedAt: null,
      totalSpend: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      reportPath: `.c1/runs/${spec.runId}/`,
      reportHtmlPath: null,
      reportGenerating: false,
      reportError: null,
      runId: spec.runId,
      runError: null,
      engine,
    });

    // Fire-and-forget; the bus drives UI updates.
    engine.run(spec).catch((e) => {
      set({ runError: e instanceof Error ? e.message : String(e), runFinishedAt: Date.now(), engine: null });
    });
  },
  abortRun: () => {
    const eng = get().engine;
    if (eng) eng.abort();
  },
  tick: () => { /* legacy no-op — real updates come from the RunEngine bus */ },
  reset: () => set({
    screen: 'keySetup',
    onboardingStep: 0,
    cells: {},
    runStartedAt: null,
    runFinishedAt: null,
    totalSpend: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    reportPath: null,
    reportHtmlPath: null,
    reportGenerating: false,
    reportError: null,
    runId: null,
    runError: null,
    engine: null,
  }),
}));

// ---------- bus → cell update helper ----------

function applyCellUpdate(u: CellUpdate): void {
  const engineToFixture: Record<EngineCellState, Cell['state']> = {
    queued: 'queued',
    running: 'running',
    passed: 'passed',
    failed: 'failed',
    error: 'error',
    aborted: 'error',   // fixture Cell type has no 'aborted'; render as error for M1
  };
  useStore.setState((s) => {
    const nextCells = { ...s.cells };
    const laneCells = { ...(nextCells[u.key.laneKey] ?? {}) };
    const prev = laneCells[u.key.taskId] ?? { state: 'queued', costUsd: 0, latencyMs: 0, passed: 0, attempted: 0 };
    // Aggregate: later severity wins over earlier (error > failed > passed > running > queued).
    const severity: Record<Cell['state'], number> = { queued: 0, running: 1, passed: 2, failed: 3, error: 4 };
    const nextState = engineToFixture[u.state];
    const state = severity[nextState] >= severity[prev.state] ? nextState : prev.state;
    // Count a session in `attempted` only when it reaches a terminal state
    // (a running update is transitional and shouldn't inflate the count).
    const isTerminal = u.state === 'passed' || u.state === 'failed' || u.state === 'error' || u.state === 'aborted';
    // Cost/tokens are handled by applyStepUpdate on each request. For
    // sessions that never got a step (setup errors), u.costUsd is 0 anyway,
    // so we can safely NOT add cost/tokens here.
    laneCells[u.key.taskId] = {
      state,
      costUsd: prev.costUsd,
      latencyMs: Math.max(prev.latencyMs, u.latencyMs),
      passed:    prev.passed    + (u.state === 'passed' ? 1 : 0),
      attempted: prev.attempted + (isTerminal ? 1 : 0),
    };
    nextCells[u.key.laneKey] = laneCells;
    return { cells: nextCells };
  });
}

function applyStepUpdate(u: StepUpdate): void {
  useStore.setState((s) => {
    const nextCells = { ...s.cells };
    const laneCells = { ...(nextCells[u.key.laneKey] ?? {}) };
    const prev = laneCells[u.key.taskId] ?? { state: 'running', costUsd: 0, latencyMs: 0, passed: 0, attempted: 0 };
    laneCells[u.key.taskId] = {
      ...prev,
      costUsd: prev.costUsd + u.costUsd,
      latencyMs: Math.max(prev.latencyMs, u.latencyMs),
    };
    nextCells[u.key.laneKey] = laneCells;
    return {
      cells: nextCells,
      totalSpend: s.totalSpend + u.costUsd,
      totalInputTokens: s.totalInputTokens + u.inputTokens,
      totalOutputTokens: s.totalOutputTokens + u.outputTokens,
    };
  });
}
