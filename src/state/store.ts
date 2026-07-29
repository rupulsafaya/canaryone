import { create } from 'zustand';
import { TASKS, ALL_MODELS, Task, Cell, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, P50_RUN_SECONDS, getDestinations, isDestinationAvailable } from '../data/fixtures.js';
import type { Config, MethodologyReport, ORKeySource, OrCatalog } from '../data/schema.js';
import type { DeterministicScan } from '../scan/deterministic.js';
import type { MatchedFile } from '../scan/glob.js';
import { loadOrCatalog, fetchModelEndpoints, readCachedEndpoints } from '../scan/or-catalog.js';
import { detectOrKey, writeConfig, runFirstRunScan } from './../scan/orchestrator.js';
import { matchFiles } from '../scan/glob.js';
import { getProvider, resolveUrlTemplate, readEnv, DIRECT_PRICING } from '../proxy/providers.js';
import { loadCatalogs, type ProviderCatalogs } from '../scan/provider-catalog.js';
import { loadRoutePicks, saveRoutePicks } from '../scan/route-picks.js';
import { buildRouteList, type Route } from '../data/route-index.js';
import { fetchVercelEndpoints, type VercelEndpoint } from '../scan/vercel-endpoints.js';
import { runMethodology, isMethodologyFresh } from '../scan/methodology.js';
import { RunEngine, type LaneSpec, type TaskSpec, type RunSpec } from '../runner/orchestrator.js';
import type { CellState as EngineCellState, CellUpdate, StepUpdate, SessionKey } from '../runner/event-bus.js';
import { randomUUID } from 'node:crypto';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';
export type EndpointStatus = 'idle' | 'loading' | 'ready' | 'error';
export type MethodologyStatus = 'idle' | 'loading' | 'ready' | 'blocked' | 'error';

export type Screen = 'keySetup' | 'apiKeys' | 'onboarding' | 'summarizeTasks' | 'methodologyCheck' | 'pickTasks' | 'taskDetail' | 'pickRoutes' | 'pickModels' | 'pickDestinations' | 'confirm' | 'liveProgress';

// A lane = one (model, destination) tuple we test. Each lane is a row in LiveProgress.
// Destination slug already encodes (router, provider), so lane key = `${modelSlug}@${destSlug}`.
export type LaneKey = string;
export const laneKey = (model: string, dest: string): LaneKey => `${model}@${dest}`;
export const parseLane = (key: LaneKey): { model: string; dest: string } => {
  // Use lastIndexOf so wire slugs that start with '@' (e.g. Cloudflare's
  // `@cf/zai-org/glm-5.2`) don't have their leading `@` mistaken for the
  // model/dest separator, which would wipe the model column and pollute
  // the dest column with the wire slug.
  const at = key.lastIndexOf('@');
  if (at < 0) return { model: key, dest: '' };
  return { model: key.slice(0, at), dest: key.slice(at + 1) };
};

type State = {
  screen: Screen;
  cwd: string;
  targetDir: string;
  configDir: string;
  forceRescan: boolean;
  /** True when the user passed --wizard to force the full onboarding flow. */
  forceWizard: boolean;
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
  /**
   * Multi-router provider catalogs (~/.c1/provider-catalogs.json). Populated
   * by loadProviderCatalogs — called on first PickDestinations mount so
   * direct/vercel/cloudflare routes can appear alongside OR endpoints.
   */
  providerCatalogs: ProviderCatalogs;
  /**
   * Vercel Gateway per-model endpoint lists (Fireworks, Morph, ...). Fetched
   * on demand when PickRoutes narrows to a Vercel model, cached in memory
   * only — Vercel's endpoints call is cheap and public.
   */
  vercelEndpointsBySlug: Record<string, VercelEndpoint[]>;
  /**
   * Search-first route picks (persist across sessions in ~/.c1/picks.json).
   * Replaces selectedModels + selectedDestinations for the default flow.
   * Each route id = `${providerSlug}::${wireSlug}`.
   */
  pickedRouteIds: Set<string>;
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
  /** When run:sessionsComplete fires — all subprocesses done, judge still may be draining. */
  sessionsCompleteAt: number | null;
  /** When run:complete fires — everything (judge + report) fully committed. */
  runFinishedAt: number | null;
  /** Total sessions expected in the current run (materialized up front). */
  totalSessions: number;
  /** How many sessions have received a judge verdict so far. */
  judgedCount: number;
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
  resumeFromCache: () => Promise<boolean>;
  loadCatalog: (force?: boolean) => Promise<void>;
  loadProviderCatalogs: () => Promise<void>;
  refreshProviderCatalog: (providerSlug: string, token: string | null) => Promise<void>;
  loadVercelEndpointsFor: (wireSlugs: string[]) => Promise<void>;
  loadRoutePicks: () => Promise<void>;
  toggleRoutePick: (routeId: string) => Promise<void>;
  clearRoutePicks: () => Promise<void>;
  /** Computed on demand — the current picked routes as full Route objects. */
  pickedRoutes: () => Route[];
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

/**
 * Extract the provider registry key from a destination slug:
 *   openrouter:baseten/fp8  → 'openrouter'
 *   vercel:openai/gpt-5     → 'vercel'
 *   cloudflare              → 'cloudflare'
 *   direct:moonshot-intl    → 'direct:moonshot-intl'
 * Direct destinations have no provider-tag segment; the whole slug is the key.
 */
function providerKeyFor(destSlug: string): string {
  if (destSlug.startsWith('direct:')) return destSlug;
  const ix = destSlug.indexOf(':');
  return ix < 0 ? destSlug : destSlug.slice(0, ix);
}

interface HydrateInput {
  destSlug: string;
  modelSlug: string;
  catalogs: ProviderCatalogs;
  orKey: string;
}

interface HydrateResult {
  forwardUrl: string;
  apiKey: string;
  modelSlugForForward: string;
  error?: string;
}

/**
 * Populate the A5 multi-router LaneSpec fields for one destination:
 *   - forwardUrl: resolved from provider registry + env (CF template)
 *   - apiKey:     provider's primary env, process.env then ~/.c1/.env
 *   - modelSlugForForward: reverse-lookup catalog canonical_map for direct
 *                          providers; identity for OR / Vercel / CF Workers AI
 * Returns an `error` string if any required config is missing so startRun
 * can surface it via runError.
 */
async function hydrateMultiRouterFields(input: HydrateInput): Promise<HydrateResult> {
  const { destSlug, modelSlug, catalogs, orKey } = input;
  const providerKey = providerKeyFor(destSlug);
  const provider = getProvider(providerKey);
  if (!provider) {
    return blank(`unknown provider "${providerKey}" for destination ${destSlug}`);
  }
  if (provider.status !== 'shipped') {
    return blank(`provider ${provider.displayName} is not yet available`);
  }

  // Forward URL — routers use a template (CF has {CLOUDFLARE_ACCOUNT_ID});
  // direct providers use a literal URL.
  let forwardUrl: string | null;
  if (provider.kind === 'router') {
    // OR keeps working when the ApiKeys env isn't populated for OR by name —
    // we already have it in `orKey`. Special-case OR to skip resolveUrlTemplate
    // (no placeholders anyway) and read directly.
    forwardUrl = provider.forwardUrlTemplate;
  } else {
    forwardUrl = provider.forwardUrl;
  }
  if (forwardUrl.includes('{')) {
    forwardUrl = await resolveUrlTemplate(forwardUrl);
  }
  if (!forwardUrl) {
    return blank(
      `${provider.displayName}: missing ${provider.extraEnvs.join(' + ')} — configure on API keys screen (\`c1 --start apiKeys\`).`,
    );
  }

  // API key — OR uses the already-detected key so we don't re-read from disk.
  let apiKey: string | null;
  if (providerKey === 'openrouter') {
    apiKey = orKey;
  } else {
    apiKey = (await readEnv(provider.primaryEnv)).value;
  }
  if (!apiKey) {
    return blank(
      `${provider.displayName}: missing ${provider.primaryEnv} — configure on API keys screen (\`c1 --start apiKeys\`).`,
    );
  }

  // Wire slug. For OR/Vercel/CF the canonical == the wire slug (registered
  // in providers.ts as identity-map providers). For direct providers, look
  // up the raw slug via the catalog's canonical_map reverse index.
  let modelSlugForForward = modelSlug;
  if (destSlug.startsWith('direct:')) {
    const cat = catalogs[providerKey];
    if (cat) {
      const raw = Object.entries(cat.canonical_map).find(([, canon]) => canon === modelSlug)?.[0];
      if (raw) modelSlugForForward = raw;
    }
  }

  return { forwardUrl, apiKey, modelSlugForForward };
}

function blank(error: string): HydrateResult {
  return { forwardUrl: '', apiKey: '', modelSlugForForward: '', error };
}

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
  screen: 'apiKeys',
  cwd: process.cwd(),
  targetDir: process.cwd(),
  configDir: process.cwd() + '/.c1',
  forceRescan: false,
  forceRescanMethodology: false,
  forceWizard: false,
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
  providerCatalogs: {},
  vercelEndpointsBySlug: {},
  pickedRouteIds: new Set<string>(),
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
  sessionsCompleteAt: null,
  runFinishedAt: null,
  totalSessions: 0,
  judgedCount: 0,
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
  /**
   * If the target dir has a complete cached wizard state — runner + matched
   * files + methodology + ≥1 included task — hydrate the store and return
   * true so callers can skip Onboarding/SummarizeTasks/MethodologyCheck/PickTasks
   * and jump straight to PickRoutes. Return false when any piece is missing.
   *
   * Reads are cache-first: runFirstRunScan uses ~/.c1/scan.json + config.json;
   * methodology cache lives on config.methodology.
   */
  resumeFromCache: async (): Promise<boolean> => {
    const s = get();
    let result;
    try {
      result = await runFirstRunScan({
        targetDir: s.targetDir,
        configDir: s.configDir,
        forceRescan: false,
      });
    } catch {
      return false;
    }
    const config = result.config;
    if (!config) return false;
    if (!config.runner?.cmd) return false;
    if (!config.methodology) return false;
    if (!Array.isArray(config.tasks?.included) || config.tasks.included.length === 0) return false;

    // Populate matched files from the cached glob so downstream code
    // (methodology fresh-check, etc.) has the file list.
    const files = await matchFiles(s.targetDir, config.testGlob.pattern);
    if (files.length === 0) return false;

    // Hydrate.
    set({ matchedFiles: files });
    get().setConfig(config);   // triggers applyConfigToTasks
    // loadMethodology reads config.methodology if fresh — no network unless
    // the file mtimes have changed since the cached scan.
    await get().loadMethodology(false);
    // Fail closed: if methodology couldn't hydrate to a runnable state, don't skip.
    const st = get().methodologyStatus;
    if (st !== 'ready' && st !== 'blocked') return false;
    return true;
  },
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
  loadProviderCatalogs: async () => {
    const cats = await loadCatalogs();
    set({ providerCatalogs: cats });
  },
  loadVercelEndpointsFor: async (wireSlugs: string[]) => {
    const have = get().vercelEndpointsBySlug;
    const need = wireSlugs.filter((s) => !(s in have));
    if (need.length === 0) return;
    // Fetch in parallel; ignore per-slug failures so one bad model doesn't
    // block the rest.
    const results = await Promise.all(need.map(async (slug) => {
      try {
        const endpoints = await fetchVercelEndpoints(slug);
        return [slug, endpoints] as const;
      } catch {
        return [slug, [] as VercelEndpoint[]] as const;
      }
    }));
    const patch: Record<string, VercelEndpoint[]> = {};
    for (const [slug, endpoints] of results) patch[slug] = endpoints;
    set((s) => ({ vercelEndpointsBySlug: { ...s.vercelEndpointsBySlug, ...patch } }));
  },
  loadRoutePicks: async () => {
    const p = await loadRoutePicks();
    set({ pickedRouteIds: new Set(p.picked) });
  },
  toggleRoutePick: async (routeId: string) => {
    const next = new Set(get().pickedRouteIds);
    if (next.has(routeId)) next.delete(routeId);
    else next.add(routeId);
    set({ pickedRouteIds: next });
    await saveRoutePicks({ picked: [...next] });
  },
  clearRoutePicks: async () => {
    set({ pickedRouteIds: new Set() });
    await saveRoutePicks({ picked: [] });
  },
  pickedRoutes: (): Route[] => {
    const s = get();
    const all = buildRouteList(s.orCatalog, s.providerCatalogs, s.vercelEndpointsBySlug);
    const picked = s.pickedRouteIds;
    return all.filter((r) => picked.has(r.id));
  },
  /**
   * Refresh one provider's catalog with OR canonical slugs as alignment
   * targets, so Haiku maps direct-provider slugs onto OR's canonical form
   * (`z-ai/glm-5.2`) instead of inventing a new one per provider.
   * ApiKeys screen calls this on [r] / [R] and after a successful paste.
   */
  refreshProviderCatalog: async (providerSlug: string, token: string | null) => {
    const { refreshCatalog } = await import('../scan/provider-catalog.js');
    const s = get();
    // Make sure the OR catalog is loaded so we have canonical slugs.
    if (!s.orCatalog) await get().loadCatalog();
    const orCanonicalSlugs = get().orCatalog?.models.map((m) => m.slug) ?? [];
    const orKey = (await detectOrKey()).value ?? null;
    await refreshCatalog(providerSlug, token, { orKey, orCanonicalSlugs });
    const cats = await loadCatalogs();
    set({ providerCatalogs: cats });
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

    // Prefer picked routes (search-first flow). Fall back to legacy
    // models × destinations if the user came via PickModels/PickDestinations.
    const pickedRoutes = s.pickedRoutes();
    const useRoutes = pickedRoutes.length > 0;
    const laneKeys = useRoutes
      ? pickedRoutes.map((r) => laneKey(
          r.wireSlug,
          r.variantSlug ? `${r.providerSlug}:${r.variantSlug}` : r.providerSlug,
        ))
      : s.lanes();

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

    // Build LaneSpec[]. Route-first path (search UI) short-circuits the
    // catalog reverse-lookup: each Route already carries its provider +
    // wire slug + pricing. Legacy path (models × destinations) still hydrates
    // via providers registry + provider-catalogs for cross-provider aggregation.
    const providerCatalogs = await loadCatalogs();
    const laneSpecs: LaneSpec[] = [];
    if (useRoutes) {
      for (const route of pickedRoutes) {
        const hydrated = await hydrateMultiRouterFields({
          destSlug: route.providerSlug,
          modelSlug: route.wireSlug,
          catalogs: providerCatalogs,
          orKey: detected.value,
        });
        if (hydrated.error) {
          set({ runError: hydrated.error });
          return;
        }
        const fallbackModelPrice =
          route.inputPrice != null && route.outputPrice != null
            ? { input: route.inputPrice, output: route.outputPrice }
            : null;
        // For gateway variants (OR pinned to a provider tag / Vercel pinned to
        // an underlying provider), thread the variant into providerTag so
        // lane.ts sends the right routing hint on the wire.
        const routerLabel = route.providerSlug.startsWith('direct:') ? 'direct' : route.providerSlug;
        const destinationSlug = route.variantSlug
          ? `${route.providerSlug}:${route.variantSlug}`
          : route.providerSlug;
        laneSpecs.push({
          modelSlug: route.wireSlug,
          destinationSlug,
          router: routerLabel,
          providerTag: route.variantSlug ?? null,
          endpoint: null,
          fallbackModelPrice,
          forwardUrl: hydrated.forwardUrl,
          apiKey: hydrated.apiKey,
          modelSlugForForward: route.wireSlug,
        });
      }
    } else {
    for (const key of laneKeys) {
      const { model: modelSlug, dest: destSlug } = parseLane(key);
      const endpoints = s.orCatalog?.endpointsBySlug?.[modelSlug]?.endpoints ?? [];
      const modelMeta = s.orCatalog?.models.find((m) => m.slug === modelSlug) ?? null;
      const [router, ...providerParts] = destSlug.split(':');
      const providerTag = providerParts.join(':') || null;
      const endpoint = endpoints.find((e) => e.providerTag === providerTag) ?? null;

      const hydrated = await hydrateMultiRouterFields({
        destSlug,
        modelSlug,
        catalogs: providerCatalogs,
        orKey: detected.value,
      });
      if (hydrated.error) {
        set({ runError: hydrated.error });
        return;
      }

      // Prefer DIRECT_PRICING for direct destinations; fall back to OR model
      // pricing otherwise (or null → computeCost returns 0 → report shows `—`).
      const directPrice = destSlug.startsWith('direct:')
        ? (DIRECT_PRICING[destSlug]?.[modelSlug] ?? null)
        : null;
      const fallbackModelPrice = directPrice
        ?? (modelMeta ? { input: modelMeta.inputPrice, output: modelMeta.outputPrice } : null);

      laneSpecs.push({
        modelSlug,
        destinationSlug: destSlug,
        router: router || 'openrouter',
        providerTag,
        endpoint,
        fallbackModelPrice,
        forwardUrl: hydrated.forwardUrl,
        apiKey: hydrated.apiKey,
        modelSlugForForward: hydrated.modelSlugForForward,
      });
    }
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
    // Judge verdict lands — record trajectory score on the cell + tick the
    // 'judged' counter so LiveProgress can render "judged N/M".
    engine.bus.on('session:judged', (u) => applyJudgedUpdate(u));
    // Three distinct phases now, three separate state fields — the TUI
    // wants to render each differently:
    //   run:sessionsComplete  → all subprocesses done, judge draining
    //   run:complete          → judge drained, report generated, everything done
    //   run:aborted           → user hit `x`, treat as complete for exit
    engine.bus.on('run:sessionsComplete', (u) => {
      set({ sessionsCompleteAt: Date.now(), totalSessions: u.totalSessions });
    });
    engine.bus.on('run:complete', () => {
      set({ runFinishedAt: Date.now(), engine: null });
    });
    engine.bus.on('run:aborted', () => {
      set({ sessionsCompleteAt: Date.now(), runFinishedAt: Date.now(), engine: null });
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
      sessionsCompleteAt: null,
      runFinishedAt: null,
      totalSessions: taskSpecs.length * laneSpecs.length * s.repeats,
      judgedCount: 0,
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
    screen: 'apiKeys',
    onboardingStep: 0,
    cells: {},
    runStartedAt: null,
    sessionsCompleteAt: null,
    runFinishedAt: null,
    totalSessions: 0,
    judgedCount: 0,
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
    // Live-activity tracking: reset runningSince/liveStepCount when the
    // cell newly enters the 'running' state (new session for a repeat > 1
    // cell). On terminal state we KEEP the last values so the display can
    // still show "took Nt · Xs" briefly after finish if we want to.
    const enteringRunning = u.state === 'running' && prev.state !== 'running';
    laneCells[u.key.taskId] = {
      state,
      costUsd: prev.costUsd,
      latencyMs: Math.max(prev.latencyMs, u.latencyMs),
      passed:    prev.passed    + (u.state === 'passed' ? 1 : 0),
      attempted: prev.attempted + (isTerminal ? 1 : 0),
      runningSince: enteringRunning ? Date.now() : prev.runningSince,
      liveStepCount: enteringRunning ? 0 : prev.liveStepCount,
      trajScore: prev.trajScore,
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
      liveStepCount: (prev.liveStepCount ?? 0) + 1,
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

/**
 * session:judged handler. The judge worker emits a JudgeUpdate carrying the
 * SessionKey + trajectoryScore + sub-scores. We put the score on the cell
 * + bump the run-level `judgedCount` so LiveProgress can show "judged N/M"
 * during the drain phase.
 */
function applyJudgedUpdate(u: { key: SessionKey; trajectoryScore: number; judgeOk: boolean }): void {
  useStore.setState((s) => {
    const nextCells = { ...s.cells };
    const laneCells = { ...(nextCells[u.key.laneKey] ?? {}) };
    const prev = laneCells[u.key.taskId];
    // Count the judge job as done regardless of whether we had a cell to attach it to.
    if (!prev) return { judgedCount: s.judgedCount + 1 };
    laneCells[u.key.taskId] = {
      ...prev,
      trajScore: u.judgeOk ? u.trajectoryScore : prev.trajScore,
    };
    nextCells[u.key.laneKey] = laneCells;
    return { cells: nextCells, judgedCount: s.judgedCount + 1 };
  });
}
