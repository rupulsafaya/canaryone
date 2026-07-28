import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../state/store.js';
import {
  ALL_MODELS as FIXTURE_ALL,
  getDestinations as fixtureDestinations,
  isDestinationAvailable,
  BASELINE_INPUT_TOKENS,
  BASELINE_OUTPUT_TOKENS,
  JUDGE_COST_PER_TASK,
  type Destination,
  type Router,
} from '../data/fixtures.js';
import { readCachedEndpoints } from '../scan/or-catalog.js';
import type { OrEndpoint, OrCatalog } from '../data/schema.js';
import { SCREEN_ACCENT, familyColor } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import { ScrollHint } from '../components/ScrollHint.tsx';
import { useScrollWindow, useTerminalDimensions } from '../hooks/useScrollWindow.ts';

type Row =
  | { kind: 'model'; modelSlug: string }
  | { kind: 'loading'; modelSlug: string }
  | { kind: 'error'; modelSlug: string; message: string }
  | { kind: 'destination'; modelSlug: string; destSlug: string };

const ROUTER_COLOR: Record<Router, string> = {
  openrouter: '#22d3ee',
  direct:     '#a78bfa',
  bedrock:    '#f97316',
  vertex:     '#4ade80',
  azure:      '#60a5fa',
};
const ROUTER_LABEL: Record<Router, string> = {
  openrouter: 'via OR',
  direct:     'direct',
  bedrock:    'bedrock',
  vertex:     'vertex',
  azure:      'azure',
};

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

/** Prefer real OR endpoints; fall back to fixture data if not yet loaded. */
function resolveDestinations(orCatalog: OrCatalog | null, modelSlug: string, isCatalogModel: boolean): {
  destinations: Destination[];
  isReal: boolean;
} {
  if (orCatalog) {
    const cached = readCachedEndpoints(orCatalog, modelSlug);
    if (cached) return { destinations: endpointsToDestinations(cached), isReal: true };
  }
  // No live endpoints yet. If we're using catalog-driven models, don't return
  // fixture data (it's misleading) — return empty so the loading state renders.
  if (isCatalogModel) return { destinations: [], isReal: false };
  return { destinations: fixtureDestinations(modelSlug), isReal: false };
}

export function PickDestinations() {
  const selectedModels = useStore((s) => s.selectedModels);
  const selectedDestinations = useStore((s) => s.selectedDestinations);
  const toggleDestination = useStore((s) => s.toggleDestination);
  const tasks = useStore((s) => s.tasks);
  const repeats = useStore((s) => s.repeats);
  const goTo = useStore((s) => s.goTo);
  const orCatalog = useStore((s) => s.orCatalog);
  const endpointStatusBySlug = useStore((s) => s.endpointStatusBySlug);
  const endpointErrorBySlug = useStore((s) => s.endpointErrorBySlug);
  const loadEndpointsFor = useStore((s) => s.loadEndpointsFor);
  const [cursor, setCursor] = useState(0);
  const [, termRows] = useTerminalDimensions();

  const modelSlugs = useMemo(() => [...selectedModels], [selectedModels]);
  const useCatalog = orCatalog !== null && orCatalog.models.length > 0;

  // Kick off endpoint fetches on mount / whenever the selection changes.
  useEffect(() => {
    if (modelSlugs.length > 0) void loadEndpointsFor(modelSlugs);
  }, [modelSlugs, loadEndpointsFor]);

  // When real endpoints arrive, clear any stale destination slugs that don't
  // exist in the fetched provider list (leftover from --start seeding or the
  // fixture era). Do NOT auto-pick a replacement — the user must select one.
  useEffect(() => {
    if (!orCatalog) return;
    for (const slug of modelSlugs) {
      const { destinations, isReal } = resolveDestinations(orCatalog, slug, useCatalog);
      if (!isReal || destinations.length === 0) continue;
      const cur = selectedDestinations[slug];
      if (!cur || cur.size === 0) continue;
      const validSlugs = new Set(destinations.map((d) => d.slug));
      const stale = [...cur].filter((s) => !validSlugs.has(s));
      for (const s of stale) toggleDestination(slug, s);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orCatalog, modelSlugs.join('|')]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const model of modelSlugs) {
      out.push({ kind: 'model', modelSlug: model });
      const status = endpointStatusBySlug[model];
      const { destinations, isReal } = resolveDestinations(orCatalog, model, useCatalog);
      if (useCatalog && !isReal && (status === 'loading' || status === 'idle' || status === undefined)) {
        out.push({ kind: 'loading', modelSlug: model });
        continue;
      }
      if (useCatalog && !isReal && status === 'error') {
        out.push({ kind: 'error', modelSlug: model, message: endpointErrorBySlug[model] ?? 'fetch failed' });
        continue;
      }
      for (const d of destinations) {
        out.push({ kind: 'destination', modelSlug: model, destSlug: d.slug });
      }
    }
    return out;
  }, [modelSlugs, orCatalog, endpointStatusBySlug, endpointErrorBySlug, useCatalog]);

  const destRowIndices = useMemo(() => rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'destination').map((x) => x.i), [rows]);

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(Math.max(0, destRowIndices.length - 1), c + 1));
    else if (input === ' ') {
      const rowIdx = destRowIndices[cursor];
      const r = rows[rowIdx];
      if (r?.kind === 'destination') toggleDestination(r.modelSlug, r.destSlug);
    }
    else if (input === 'R') void loadEndpointsFor(modelSlugs, true);
    else if (key.return) {
      const allHaveDest = modelSlugs.every((m) => (selectedDestinations[m]?.size ?? 0) > 0);
      if (modelSlugs.length > 0 && allHaveDest) goTo('confirm');
    }
    else if (input === 'b' || key.escape) goTo('pickModels');
    else if (input === 'q') process.exit(0);
  });

  const missingDestFor = modelSlugs.filter((m) => (selectedDestinations[m]?.size ?? 0) === 0);
  const canAdvance = modelSlugs.length > 0 && missingDestFor.length === 0;

  // Chrome: border(2) + title(1) + margin(1) + info(1) + margin(1) + col headers(1) + divider(1) + footer(3) + scroll hints(2) = ~13
  const visibleRows = Math.max(6, termRows - 13);
  const focusedRowIdx = destRowIndices[cursor] ?? 0;
  const { windowStart, windowEnd, overflowAbove, overflowBelow } = useScrollWindow(rows.length, focusedRowIdx, visibleRows);

  const totalLanes = useMemo(() => {
    let n = 0;
    for (const m of selectedModels) n += (selectedDestinations[m]?.size ?? 0);
    return n;
  }, [selectedModels, selectedDestinations]);

  const includedTasks = tasks.filter((t) => t.included);
  const estCost = useMemo(() => {
    let total = 0;
    for (const model of selectedModels) {
      const dests = selectedDestinations[model] ?? new Set<string>();
      const { destinations } = resolveDestinations(orCatalog, model, useCatalog);
      for (const destSlug of dests) {
        const d = destinations.find((x) => x.slug === destSlug);
        if (!d) continue;
        total += ((BASELINE_INPUT_TOKENS / 1_000_000) * d.inputPrice + (BASELINE_OUTPUT_TOKENS / 1_000_000) * d.outputPrice) * includedTasks.length * repeats;
      }
    }
    total += JUDGE_COST_PER_TASK * includedTasks.length * totalLanes * repeats;
    return total;
  }, [selectedModels, selectedDestinations, includedTasks.length, repeats, totalLanes, orCatalog, useCatalog]);

  const anyLoading = modelSlugs.some((s) => endpointStatusBySlug[s] === 'loading');

  return (
    <Frame
      title="Pick destinations (per model)"
      accent={SCREEN_ACCENT.pickModels}
      subtitle={`${totalLanes} lanes · ${includedTasks.length} tasks × ${repeats} rpts ≈ $${estCost.toFixed(2)}`}
      footer={
        <Box flexDirection="column">
          <Text color="gray">
            <Text color="cyan">↑↓</Text> nav · <Text color="cyan">space</Text> toggle · <Text color="cyan">R</Text> refresh · {canAdvance
              ? <Text color="#22c55e" bold>enter confirm →</Text>
              : missingDestFor.length > 0
                ? <Text dimColor>enter (pick ≥1 provider for each model)</Text>
                : <Text dimColor>enter (pick ≥1 model first)</Text>} · <Text color="cyan">b</Text> back · <Text color="cyan">q</Text> quit
          </Text>
          {anyLoading && <Text color="#eab308"><Spinner type="dots" /> fetching provider endpoints from OpenRouter…</Text>}
        </Box>
      }
    >
      <Box flexShrink={0}>
        <Text color="gray" dimColor>Each (model, destination) is a lane. Destination = router + provider. Data from OR /models/{'{'}slug{'}'}/endpoints.</Text>
      </Box>
      <Box marginTop={1} flexShrink={0} />

      <Box flexShrink={0}>
        <Box width={6}><Text color="magenta" bold>   </Text></Box>
        <Box width={28}><Text color="magenta" bold>Provider</Text></Box>
        <Box width={10}><Text color="magenta" bold>Router</Text></Box>
        <Box width={16}><Text color="magenta" bold>$/M in · out</Text></Box>
        <Box width={9}><Text color="magenta" bold>Ctx</Text></Box>
        <Box width={7}><Text color="magenta" bold>Up</Text></Box>
        <Text color="magenta" bold>Notes</Text>
      </Box>
      <Box flexShrink={0}><Text color="gray" dimColor>{'─'.repeat(117)}</Text></Box>

      <ScrollHint side="above" count={overflowAbove} />

      {rows.slice(windowStart, windowEnd).map((row, offset) => {
        const i = windowStart + offset;
        if (row.kind === 'model') {
          const catalogModel = orCatalog?.models.find((m) => m.slug === row.modelSlug);
          const fixtureModel = FIXTURE_ALL.find((m) => m.slug === row.modelSlug);
          const model = catalogModel ?? fixtureModel;
          if (!model) return null;
          const { destinations, isReal } = resolveDestinations(orCatalog, row.modelSlug, useCatalog);
          const picked = selectedDestinations[row.modelSlug]?.size ?? 0;
          return (
            <Box key={`m${i}`} marginTop={offset === 0 || i === 0 ? 0 : 1} flexShrink={0}>
              <Box width={6}><Text color={familyColor(model.family)} bold>●   </Text></Box>
              <Box width={44}><Text color={familyColor(model.family)} bold>{truncate(model.displayName, 42)}</Text></Box>
              <Text color="gray" dimColor>
                {isReal ? `${picked} of ${destinations.length} providers${destinations.length === 1 ? '' : ''} · ${picked === 0 ? 'NO LANE (pick ≥1)' : `${picked} lane${picked === 1 ? '' : 's'}`}` : ''}
                {!isReal && useCatalog && ' (fetching…)'}
              </Text>
            </Box>
          );
        }
        if (row.kind === 'loading') {
          return (
            <Box key={`l${i}`} flexShrink={0}>
              <Box width={6}><Text> </Text></Box>
              <Text color="#eab308"><Spinner type="dots" /> fetching providers from OpenRouter…</Text>
            </Box>
          );
        }
        if (row.kind === 'error') {
          return (
            <Box key={`e${i}`} flexShrink={0}>
              <Box width={6}><Text> </Text></Box>
              <Text color="#ef4444">✗ {row.message.slice(0, 100)}</Text>
              <Text color="gray" dimColor>  · press R to retry</Text>
            </Box>
          );
        }
        // row.kind === 'destination'
        const { destinations } = resolveDestinations(orCatalog, row.modelSlug, useCatalog);
        const dest = destinations.find((d) => d.slug === row.destSlug);
        if (!dest) return null;
        const active = i === focusedRowIdx;
        const isPicked = selectedDestinations[row.modelSlug]?.has(row.destSlug);
        const available = isDestinationAvailable(dest);
        const check = isPicked ? '●' : '○';
        const dim = !available;
        const cachedEndpoints = orCatalog ? readCachedEndpoints(orCatalog, row.modelSlug) : null;
        const rawEp = cachedEndpoints?.find((e) => `openrouter:${e.providerTag}` === row.destSlug);
        const uptime = rawEp?.uptimePct30m;
        return (
          <Box key={`d${i}`} flexShrink={0}>
            <Box width={6}>
              <Text>   </Text>
              {active ? <Text color="cyan" bold>▸ </Text> : <Text>  </Text>}
              <Text color={isPicked ? '#22c55e' : available ? '#64748b' : '#3f3f46'} dimColor={dim}>{check}</Text>
            </Box>
            <Box width={28}>
              <Text color={active ? 'white' : 'gray'} bold={active} dimColor={dim}>{truncate(dest.displayName, 24)}</Text>
              {dest.isFirstParty && <Text color="#a78bfa" dimColor> ★</Text>}
            </Box>
            <Box width={10}>
              <Text color={ROUTER_COLOR[dest.router]} dimColor={dim}>{ROUTER_LABEL[dest.router]}</Text>
            </Box>
            <Box width={16}><Text color="gray" dimColor={dim}>${dest.inputPrice.toFixed(2).padStart(5)} · ${dest.outputPrice.toFixed(2).padStart(5)}</Text></Box>
            <Box width={9}>
              <Text color="gray" dimColor={dim}>
                {rawEp?.contextLength ? `${(rawEp.contextLength / 1000).toFixed(0)}k` : ' '}
              </Text>
            </Box>
            <Box width={7}>
              <Text color={uptime == null ? 'gray' : uptime >= 99 ? '#22c55e' : uptime >= 95 ? '#eab308' : '#f97316'} dimColor={dim}>
                {uptime == null ? ' ' : `${Math.round(uptime)}%`}
              </Text>
            </Box>
            <Text color="gray" dimColor>
              {dest.isPreview && dest.requiresKey && !available ? <Text color="#f97316">requires {dest.requiresKey} (v0.1 preview)</Text> :
               dest.isPreview ? <Text color="#f97316">v0.1 preview</Text> :
               dest.isFirstParty ? 'first-party' : ''}
            </Text>
          </Box>
        );
      })}

      <ScrollHint side="below" count={overflowBelow} />
    </Frame>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}
