import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import {
  ALL_MODELS as FIXTURE_ALL,
  getDestinations as fixtureDestinations,
  BASELINE_INPUT_TOKENS,
  BASELINE_OUTPUT_TOKENS,
  JUDGE_COST_PER_TASK,
  P50_RUN_SECONDS,
  type Destination,
} from '../data/fixtures.js';
import { readCachedEndpoints } from '../scan/or-catalog.js';
import type { OrCatalog, OrEndpoint } from '../data/schema.js';
import { SCREEN_ACCENT, familyColor } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

const JUDGE_MODEL = 'anthropic/claude-haiku-4.5';

function endpointsToDestinations(endpoints: OrEndpoint[]): Destination[] {
  return endpoints.map((e) => ({
    slug: `openrouter:${e.providerTag}`,
    router: 'openrouter' as const,
    provider: e.provider,
    variant: e.quantization ?? undefined,
    displayName: e.displayName,
    inputPrice: e.inputPrice,
    outputPrice: e.outputPrice,
    isFirstParty: e.isFirstParty,
    isPreview: false,
  }));
}

function resolveDestinations(orCatalog: OrCatalog | null, modelSlug: string, useCatalog: boolean): Destination[] {
  if (orCatalog) {
    const cached = readCachedEndpoints(orCatalog, modelSlug);
    if (cached) return endpointsToDestinations(cached);
  }
  return useCatalog ? [] : fixtureDestinations(modelSlug);
}

export function Confirm() {
  const tasks = useStore((s) => s.tasks);
  const selectedModels = useStore((s) => s.selectedModels);
  const selectedDestinations = useStore((s) => s.selectedDestinations);
  const repeats = useStore((s) => s.repeats);
  const parallelism = useStore((s) => s.parallelism);
  const maxSpend = useStore((s) => s.maxSpend);
  const setMaxSpend = useStore((s) => s.setMaxSpend);
  const setParallelism = useStore((s) => s.setParallelism);
  const setRepeats = useStore((s) => s.setRepeats);
  const goTo = useStore((s) => s.goTo);
  const startRun = useStore((s) => s.startRun);
  const orCatalog = useStore((s) => s.orCatalog);
  const loadEndpointsFor = useStore((s) => s.loadEndpointsFor);
  const pickedRouteIds = useStore((s) => s.pickedRouteIds);
  const pickedRoutes = useStore((s) => s.pickedRoutes);
  const preflight = useStore((s) => s.preflight);
  const runPreflight = useStore((s) => s.runPreflight);
  const toggleRoutePick = useStore((s) => s.toggleRoutePick);
  type EditField = 'cap' | 'parallelism' | 'repeats';
  const [editing, setEditing] = useState<EditField | null>(null);
  const [draft, setDraft] = useState('');
  const [forceThrough, setForceThrough] = useState(false);

  // Ensure real endpoints are loaded so pricing on this screen matches what
  // was shown on PickDestinations. Idempotent — cached hits are instant.
  const modelSlugs = useMemo(() => [...selectedModels], [selectedModels]);
  useEffect(() => {
    if (modelSlugs.length > 0) void loadEndpointsFor(modelSlugs);
  }, [modelSlugs, loadEndpointsFor]);

  // Auto-run preflight on mount + whenever picks change. Cheap (~$0.001/lane)
  // and catches billing gates + entitlement issues before a 20-min run.
  const picksSignature = useMemo(() => [...pickedRouteIds].sort().join(','), [pickedRouteIds]);
  useEffect(() => {
    if (pickedRouteIds.size > 0 && preflight.status !== 'running') {
      void runPreflight();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picksSignature]);

  const useCatalog = orCatalog !== null && orCatalog.models.length > 0;

  const openEditor = (field: EditField) => {
    const current = field === 'cap' ? maxSpend.toFixed(2) : field === 'parallelism' ? String(parallelism) : String(repeats);
    setDraft(current);
    setEditing(field);
  };
  const commitEditor = () => {
    if (editing === 'cap') {
      const v = parseFloat(draft);
      if (!isNaN(v) && v > 0) setMaxSpend(v);
    } else if (editing === 'parallelism') {
      const v = parseInt(draft, 10);
      if (!isNaN(v) && v > 0) setParallelism(v);
    } else if (editing === 'repeats') {
      const v = parseInt(draft, 10);
      if (!isNaN(v) && v > 0) setRepeats(v);
    }
    setEditing(null);
  };

  useInput((input, key) => {
    if (editing) {
      if (key.return) { commitEditor(); return; }
      if (key.escape) { setEditing(null); return; }
      if (key.backspace || key.delete) { setDraft((d) => d.slice(0, -1)); return; }
      const allowed = editing === 'cap' ? /^[\d.]$/ : /^[\d]$/;
      if (input && allowed.test(input)) setDraft((d) => d + input);
      return;
    }
    if (key.return) {
      // Gate on preflight — block on billing/auth/model-access unless forced.
      const blocking = preflight.results.filter((r) =>
        !r.result.ok && (r.result.category === 'auth' || r.result.category === 'billing' || r.result.category === 'model-access'),
      );
      if (blocking.length > 0 && !forceThrough) {
        // Ignore Enter until user hits 's' (skip failing) or 'f' (force).
        return;
      }
      startRun();
    }
    else if (input === 't') goTo('pickTasks');
    else if (input === 'm') goTo('pickRoutes');
    else if (input === 'h') goTo('pickRoutes');
    else if (input === 'c') openEditor('cap');
    else if (input === 'p') openEditor('parallelism');
    else if (input === 'r') openEditor('repeats');
    else if (input === 'P') { void runPreflight(); }        // manual retry
    else if (input === 's') {
      // Skip failing lanes — un-toggle their picks so buildLaneSpecs excludes them.
      const failingLaneKeys = new Set(preflight.results.filter((r) => !r.result.ok).map((r) => r.laneKey));
      if (failingLaneKeys.size === 0) return;
      // Route ids don't equal laneKeys; recompute pickedRoutes and unpick the ones whose synthesized laneKey is in failingLaneKeys.
      for (const route of pickedRoutes()) {
        const dest = route.variantSlug ? `${route.providerSlug}:${route.variantSlug}` : route.providerSlug;
        const k = `${route.wireSlug}@${dest}`;
        if (failingLaneKeys.has(k)) void toggleRoutePick(route.id);
      }
    }
    else if (input === 'f') setForceThrough((v) => !v);
    else if (input === 'q' || key.escape) process.exit(0);
  });

  const includedTasks = tasks.filter((t) => t.included);
  interface Lane {
    model: string;
    dest: string;
    router: string;
    routerLabel: string;
    providerLabel: string;
    inputPrice: number;
    outputPrice: number;
    family: string;
    modelDisplay: string;
  }
  const lanes: Lane[] = [];

  // Route-first path (search UI). Falls through to legacy models × destinations
  // only when the user has zero route picks (e.g. arrived via --start pickModels).
  if (pickedRouteIds.size > 0) {
    for (const r of pickedRoutes()) {
      lanes.push({
        model: r.wireSlug,
        dest: r.providerSlug,
        router: r.providerSlug.startsWith('direct:') ? 'direct' : r.providerSlug,
        routerLabel: r.routerLabel,
        providerLabel: r.providerLabel,
        inputPrice: r.inputPrice ?? 0,
        outputPrice: r.outputPrice ?? 0,
        family: r.family,
        modelDisplay: r.displayName,
      });
    }
  } else {
    for (const model of selectedModels) {
      const destinations = resolveDestinations(orCatalog, model, useCatalog);
      const dests = selectedDestinations[model] ?? new Set<string>();
      for (const destSlug of dests) {
        const d = destinations.find((x) => x.slug === destSlug);
        if (!d) continue;
        const catalogModel = orCatalog?.models.find((x) => x.slug === model);
        const family = catalogModel?.family ?? 'other';
        lanes.push({
          model,
          dest: destSlug,
          router: d.router,
          routerLabel: d.router,
          providerLabel: d.displayName,
          inputPrice: d.inputPrice,
          outputPrice: d.outputPrice,
          family,
          modelDisplay: catalogModel?.displayName ?? model,
        });
      }
    }
  }

  const totalRuns = includedTasks.length * lanes.length * repeats;
  const seqSec = totalRuns * P50_RUN_SECONDS;
  // Parallelism is capped by total runs (nothing to parallelize past that),
  // NOT by lane count — sessions on the same lane are independent subprocesses
  // and can run concurrently. And no individual session can run faster than
  // P50_RUN_SECONDS.
  const effectiveConcurrency = Math.min(parallelism, Math.max(1, totalRuns));
  const parSec = totalRuns === 0 ? 0 : Math.max(P50_RUN_SECONDS, seqSec / effectiveConcurrency);

  let destCost = 0;
  for (const l of lanes) {
    destCost += ((BASELINE_INPUT_TOKENS / 1_000_000) * l.inputPrice + (BASELINE_OUTPUT_TOKENS / 1_000_000) * l.outputPrice) * includedTasks.length * repeats;
  }
  const judgeCost = JUDGE_COST_PER_TASK * totalRuns;
  const totalCost = destCost + judgeCost;
  const overCap = totalCost > maxSpend;
  const credits = orCatalog?.credits ?? null;
  const overCredits = credits != null && totalCost > credits;

  const preflightBlocking = preflight.results.filter((r) =>
    !r.result.ok && (r.result.category === 'auth' || r.result.category === 'billing' || r.result.category === 'model-access'),
  ).length;
  const preflightWarnings = preflight.results.filter((r) =>
    !r.result.ok && !(r.result.category === 'auth' || r.result.category === 'billing' || r.result.category === 'model-access'),
  ).length;

  return (
    <Frame
      title="Confirm & run"
      accent={SCREEN_ACCENT.confirm}
      subtitle={credits != null ? `credits $${credits.toFixed(2)}` : ''}
      footer={
        editing ? (
          <Text color="cyan">
            {editing === 'cap' ? 'New cap ($): ' : editing === 'parallelism' ? 'New parallelism: ' : 'New repeats: '}
            <Text color="white" bold>{draft}</Text><Text color="gray">▏</Text><Text color="gray"> · enter save · esc cancel</Text>
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text color="gray">
              {overCap
                ? <Text color="gray">enter <Text dimColor>(blocked, over cap)</Text></Text>
                : totalRuns === 0
                  ? <Text color="gray">enter <Text dimColor>(blocked, 0 runs)</Text></Text>
                  : preflightBlocking > 0 && !forceThrough
                    ? <Text color="gray">enter <Text color="#ef4444">(blocked, {preflightBlocking} preflight fail{preflightBlocking === 1 ? '' : 's'})</Text></Text>
                    : <Text color="#22c55e" bold>enter RUN</Text>}
              <Text color="gray"> · </Text><Text color="cyan">c</Text> cap · <Text color="cyan">p</Text> par · <Text color="cyan">r</Text> reps · <Text color="cyan">t</Text> tasks · <Text color="cyan">m</Text> routes · <Text color="cyan">q</Text> quit
            </Text>
            {preflightBlocking > 0 && !forceThrough && (
              <Text color="gray"><Text color="cyan">s</Text> skip failing lanes · <Text color="cyan">f</Text> force through · <Text color="cyan">P</Text> retry preflight</Text>
            )}
          </Box>
        )
      }
    >
      <Section title="Scope">
        <Text>
          <Text color="white" bold>{includedTasks.length}</Text> tasks × <Text color="white" bold>{lanes.length}</Text> lanes (model, destination) × <Text color="white" bold>{repeats}</Text> repeats = <Text color="cyan" bold>{totalRuns} runs</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Box width={3}><Text color="gray" dimColor>   </Text></Box>
            <Box width={26} justifyContent="flex-end"><Text color="gray" dimColor bold>Model  </Text></Box>
            <Box width={22}><Text color="gray" dimColor bold>  Provider</Text></Box>
            <Box width={12}><Text color="gray" dimColor bold>Router</Text></Box>
            <Text color="gray" dimColor bold>$/M in · out</Text>
          </Box>
          {lanes.slice(0, 10).map((l) => {
            const dim = l.providerLabel === '(any)';
            return (
              <Box key={`${l.model}@${l.dest}::${l.providerLabel}`}>
                <Box width={3}>
                  <Text> </Text>
                  <Text color={familyColor(l.family)}>● </Text>
                </Box>
                <Box width={26} justifyContent="flex-end">
                  <Text color="white">{truncateLeft(l.modelDisplay, 24)}  </Text>
                </Box>
                <Box width={22}>
                  <Text color={dim ? 'gray' : '#f472b6'} dimColor={dim}>  {truncate(l.providerLabel, 18)}</Text>
                </Box>
                <Box width={12}><Text color={routerColor(l.router)}>{truncate(l.routerLabel, 10)}</Text></Box>
                <Text color="gray">
                  {l.inputPrice > 0 || l.outputPrice > 0
                    ? `$${l.inputPrice.toFixed(2)} · $${l.outputPrice.toFixed(2)}`
                    : '  —  ·   —  '}
                </Text>
              </Box>
            );
          })}
          {lanes.length > 10 && <Box><Text color="gray" dimColor>{'  '}+ {lanes.length - 10} more lanes (view all in .c1/config.json)</Text></Box>}
          {lanes.length === 0 && <Box><Text color="#ef4444" dimColor>{'  '}no lanes yet — press <Text color="cyan">m</Text> to open route picker</Text></Box>}
        </Box>
      </Section>

      <Section title={
        preflight.status === 'running' ? 'Preflight (probing…)'
        : preflightBlocking > 0 ? `Preflight — ${preflightBlocking} blocked`
        : preflightWarnings > 0 ? `Preflight — ${preflightWarnings} warn`
        : preflight.results.length > 0 ? 'Preflight — all green'
        : 'Preflight'
      }>
        {preflight.status === 'idle' && (
          <Text color="gray" dimColor>waiting to probe — 1-token check per lane before we spend real time on this run.</Text>
        )}
        {preflight.error && <Text color="#ef4444">preflight setup error: {preflight.error}</Text>}
        {preflight.results.length > 0 && (
          <Box flexDirection="column">
            {preflight.results.slice(0, 12).map((r) => (
              <Box key={r.laneKey}>
                <Box width={3}>
                  <Text color={r.result.ok ? '#22c55e' : (r.result.category === 'auth' || r.result.category === 'billing' || r.result.category === 'model-access') ? '#ef4444' : '#eab308'}>
                    {r.result.ok ? '✓' : (r.result.category === 'auth' || r.result.category === 'billing' || r.result.category === 'model-access') ? '✗' : '⚠'}
                  </Text>
                </Box>
                <Box width={44}>
                  <Text color={r.result.ok ? 'gray' : 'white'}>
                    {truncate(r.modelSlug, 24)} <Text color="gray" dimColor>@</Text> {truncate(r.destinationSlug.replace(/^direct:/,'') + (r.providerTag ? ` ${r.providerTag}` : ''), 18)}
                  </Text>
                </Box>
                <Text color="gray">{r.result.message}{r.result.latencyMs != null ? ` (${r.result.latencyMs}ms)` : ''}</Text>
              </Box>
            ))}
            {preflight.results.length > 12 && (
              <Text color="gray" dimColor>  + {preflight.results.length - 12} more probes</Text>
            )}
            {preflightBlocking > 0 && (
              <Box marginTop={1}>
                <Text color="#ef4444" bold>⚠ {preflightBlocking} lane{preflightBlocking === 1 ? '' : 's'} will fail on billing/auth/model access.</Text>
              </Box>
            )}
            {forceThrough && (
              <Box><Text color="#eab308" bold>force mode ON — enter will launch despite failing lanes (press f to toggle)</Text></Box>
            )}
          </Box>
        )}
      </Section>

      <Section title="Time">
        <Text>
          ~ <Text color="white" bold>{fmtDuration(seqSec)}</Text> sequential · with parallelism=<Text color="cyan" bold>{parallelism}</Text> (concurrent=<Text color="cyan">{effectiveConcurrency}</Text>): <Text color="cyan" bold>~ {fmtDuration(parSec)}</Text> wall-clock <Text color="gray" dimColor>(press <Text color="cyan">p</Text> to change)</Text>
        </Text>
      </Section>

      <Section title="Cost">
        <KV
          label={`Destination LLMs (${BASELINE_INPUT_TOKENS}+${BASELINE_OUTPUT_TOKENS} tok/run × ${totalRuns} runs, per-provider $)`}
          value={`~ $${destCost.toFixed(2)}`}
        />
        <KV
          label={`Judge (${JUDGE_MODEL}, ~$${JUDGE_COST_PER_TASK.toFixed(3)} × ${totalRuns} judgments)`}
          value={`~ $${judgeCost.toFixed(2)}`}
        />
        <Box><Text color="gray">  ─────────────────────────────────────────────────────</Text></Box>
        <KV label="Total estimated" value={`~ $${totalCost.toFixed(2)}`} highlight color={overCap ? '#ef4444' : '#22c55e'} />
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">
            Guardrail: hard cap at <Text bold color={overCap ? '#ef4444' : 'white'}>${maxSpend.toFixed(2)}</Text> <Text color="gray" dimColor>(--max-spend override)</Text>
          </Text>
          {credits != null && (
            <Text color={overCredits ? '#ef4444' : 'gray'} dimColor={!overCredits}>
              OpenRouter credits: <Text bold color={overCredits ? '#ef4444' : '#22c55e'}>${credits.toFixed(2)}</Text>
              {overCredits && <Text color="#ef4444" bold>  ⚠ estimated cost exceeds credits</Text>}
            </Text>
          )}
          {overCap && (
            <Text color="#ef4444" bold>
              ⚠ OVER CAP by ${(totalCost - maxSpend).toFixed(2)} · press <Text color="cyan">c</Text> to raise cap, or <Text color="cyan">t</Text>/<Text color="cyan">m</Text>/<Text color="cyan">h</Text> to trim selection
            </Text>
          )}
        </Box>
      </Section>
    </Frame>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
      <Text color="magenta" bold>{title}</Text>
      <Box paddingLeft={2} flexDirection="column">{children}</Box>
    </Box>
  );
}
function KV({ label, value, highlight, color }: { label: string; value: string; highlight?: boolean; color?: string }) {
  return (
    <Box>
      <Box width={70}><Text color={highlight ? 'white' : 'gray'} bold={highlight}>{label}</Text></Box>
      <Text color={color ?? (highlight ? 'white' : 'gray')} bold={highlight}>{value}</Text>
    </Box>
  );
}
function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}
function truncateLeft(s: string, n: number) {
  return s.length > n ? '…' + s.slice(s.length - n + 1) : s.padStart(n);
}
function routerColor(r: string) {
  return r === 'direct' ? '#a78bfa' : r === 'bedrock' ? '#f97316' : r === 'vertex' ? '#4ade80' : r === 'azure' ? '#60a5fa' : '#22d3ee';
}
function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
