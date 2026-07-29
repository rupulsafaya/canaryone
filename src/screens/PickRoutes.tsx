// Search-first route picker. Replaces PickModels + PickDestinations as the
// default flow. Type to filter across every configured catalog (OR + Vercel
// + CF + direct providers); space to toggle; picks persist across sessions
// in ~/.c1/picks.json.

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT, familyColor } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import { ScrollHint } from '../components/ScrollHint.tsx';
import { useScrollWindow, useTerminalDimensions } from '../hooks/useScrollWindow.ts';
import { buildRouteList, filterRoutes, type Route } from '../data/route-index.js';
import { BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK } from '../data/fixtures.js';

export function PickRoutes() {
  const orCatalog = useStore((s) => s.orCatalog);
  const orCatalogStatus = useStore((s) => s.orCatalogStatus);
  const orCatalogError = useStore((s) => s.orCatalogError);
  const providerCatalogs = useStore((s) => s.providerCatalogs);
  const pickedRouteIds = useStore((s) => s.pickedRouteIds);
  const loadCatalog = useStore((s) => s.loadCatalog);
  const loadProviderCatalogs = useStore((s) => s.loadProviderCatalogs);
  const loadRoutePicks = useStore((s) => s.loadRoutePicks);
  const toggleRoutePick = useStore((s) => s.toggleRoutePick);
  const loadEndpointsFor = useStore((s) => s.loadEndpointsFor);
  const endpointStatusBySlug = useStore((s) => s.endpointStatusBySlug);
  const vercelEndpointsBySlug = useStore((s) => s.vercelEndpointsBySlug);
  const loadVercelEndpointsFor = useStore((s) => s.loadVercelEndpointsFor);
  const tasks = useStore((s) => s.tasks);
  const repeats = useStore((s) => s.repeats);
  const goTo = useStore((s) => s.goTo);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [, termRows] = useTerminalDimensions();

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  useEffect(() => { void loadProviderCatalogs(); }, [loadProviderCatalogs]);
  useEffect(() => { void loadRoutePicks(); }, [loadRoutePicks]);

  // When the user's filter narrows to a small OR-model set, auto-fetch
  // per-endpoint data so variant rows can render underneath. Debounced
  // to avoid a burst of fetches while typing.
  const orMatches = useMemo(() => {
    if (!orCatalog) return [] as string[];
    const q = query.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    const tokens = q.split(/\s+/);
    return orCatalog.models
      .filter((m) => {
        const hay = (m.slug + ' ' + (m.displayName ?? '') + ' ' + m.family).toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
      .map((m) => m.slug);
  }, [query, orCatalog]);
  useEffect(() => {
    if (orMatches.length === 0 || orMatches.length > 5) return;
    const need = orMatches.filter((s) => {
      const st = endpointStatusBySlug[s];
      const cached = orCatalog?.endpointsBySlug?.[s]?.endpoints;
      return st !== 'loading' && st !== 'ready' && !cached;
    });
    if (need.length === 0) return;
    const timer = setTimeout(() => { void loadEndpointsFor(need); }, 300);
    return () => clearTimeout(timer);
  }, [orMatches, endpointStatusBySlug, orCatalog, loadEndpointsFor]);

  // Same auto-fetch pattern for Vercel — narrow the filter to ≤5 Vercel
  // wire slugs and we fetch each model's underlying-provider list.
  const vercelMatches = useMemo(() => {
    const cat = providerCatalogs['vercel'];
    if (!cat) return [] as string[];
    const q = query.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    const tokens = q.split(/\s+/);
    return cat.models_raw.filter((slug) => {
      const hay = slug.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [query, providerCatalogs]);
  useEffect(() => {
    if (vercelMatches.length === 0 || vercelMatches.length > 5) return;
    const need = vercelMatches.filter((s) => !(s in vercelEndpointsBySlug));
    if (need.length === 0) return;
    const timer = setTimeout(() => { void loadVercelEndpointsFor(need); }, 300);
    return () => clearTimeout(timer);
  }, [vercelMatches, vercelEndpointsBySlug, loadVercelEndpointsFor]);

  const allRoutes = useMemo(
    () => buildRouteList(orCatalog, providerCatalogs, vercelEndpointsBySlug),
    [orCatalog, providerCatalogs, vercelEndpointsBySlug],
  );
  const filtered = useMemo(() => filterRoutes(allRoutes, query), [allRoutes, query]);

  // Reset cursor whenever the filter narrows below its current position.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const totalRoutes = allRoutes.length;
  const sourceCount = useMemo(() => {
    const set = new Set(allRoutes.map((r) => r.providerSlug));
    return set.size;
  }, [allRoutes]);

  const pickedCount = pickedRouteIds.size;
  const includedTasks = useMemo(() => tasks.filter((t) => t.included), [tasks]);
  const estCost = useMemo(() => {
    const pickedRoutes = allRoutes.filter((r) => pickedRouteIds.has(r.id));
    let total = 0;
    for (const r of pickedRoutes) {
      const inPrice = r.inputPrice ?? 0;
      const outPrice = r.outputPrice ?? 0;
      total += ((BASELINE_INPUT_TOKENS / 1_000_000) * inPrice + (BASELINE_OUTPUT_TOKENS / 1_000_000) * outPrice) * includedTasks.length * repeats;
    }
    total += JUDGE_COST_PER_TASK * includedTasks.length * pickedCount * repeats;
    return total;
  }, [allRoutes, pickedRouteIds, includedTasks.length, repeats, pickedCount]);

  useInput((input, key) => {
    // Escape: first clear query, second go back. Prevents accidental exit
    // when the user's mid-filter.
    if (key.escape) {
      if (query.length > 0) { setQuery(''); return; }
      goTo('methodologyCheck');
      return;
    }
    // Ctrl-C exits (matches most shell reflexes; ink otherwise swallows).
    if (input === '\x03') process.exit(0);
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(Math.max(0, filtered.length - 1), c + 1)); return; }
    if (key.return) {
      if (pickedCount > 0 && includedTasks.length > 0) goTo('confirm');
      return;
    }
    if (input === ' ') {
      const r = filtered[cursor];
      if (r) void toggleRoutePick(r.id);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    // Ctrl-U clears the whole query (common shell reflex).
    if (input === '\x15') { setQuery(''); return; }
    // Any other printable input becomes filter text — includes multi-char paste.
    const cleaned = sanitizeInput(input);
    if (cleaned) setQuery((q) => q + cleaned);
  });

  const canAdvance = pickedCount > 0 && includedTasks.length > 0;
  const visibleRows = Math.max(6, termRows - 15);
  const { windowStart, windowEnd, overflowAbove, overflowBelow } = useScrollWindow(filtered.length, cursor, visibleRows);

  const isLoadingAny = orCatalogStatus === 'loading';

  return (
    <Frame
      title="Pick routes"
      accent={SCREEN_ACCENT.pickModels}
      subtitle={`${pickedCount} pick${pickedCount === 1 ? '' : 's'} · ${includedTasks.length} task${includedTasks.length === 1 ? '' : 's'} × ${repeats} rpt ≈ $${estCost.toFixed(2)}`}
      footer={
        <Box flexDirection="column">
          <Text color="gray">
            <Text color="cyan">type</Text> filter · <Text color="cyan">↑↓</Text> nav · <Text color="cyan">space</Text> toggle · {canAdvance
              ? <Text color="#22c55e" bold>enter continue →</Text>
              : pickedCount === 0
                ? <Text dimColor>enter (pick ≥1 route)</Text>
                : <Text dimColor>enter (no tasks included)</Text>} · <Text color="cyan">esc</Text> back · <Text color="cyan">^U</Text> clear · <Text color="cyan">q</Text> quit
          </Text>
          {isLoadingAny && <Text color="#eab308"><Spinner type="dots" /> loading OR catalog…</Text>}
          {orCatalogError && !isLoadingAny && <Text color="#ef4444">catalog error: {orCatalogError.slice(0, 100)}</Text>}
        </Box>
      }
    >
      {/* Search input */}
      <Box flexShrink={0}>
        <Box width={10}><Text color="magenta" bold>Search:</Text></Box>
        <Text color="white">{query}</Text><Text color="gray">▏</Text>
        <Box flexGrow={1} />
        <Text color="gray" dimColor>
          {filtered.length === totalRoutes
            ? `${totalRoutes.toLocaleString()} routes across ${sourceCount} sources`
            : `${filtered.length.toLocaleString()} of ${totalRoutes.toLocaleString()} match`}
        </Text>
      </Box>
      <Box marginTop={1} flexShrink={0} />

      {/* Column headers */}
      <Box flexShrink={0}>
        <Box width={4}><Text color="magenta" bold>   </Text></Box>
        <Box width={54}><Text color="magenta" bold>Model</Text></Box>
        <Box width={18}><Text color="magenta" bold>Provider</Text></Box>
        <Text color="magenta" bold>$/M in · out</Text>
      </Box>
      <Box flexShrink={0}><Text color="gray" dimColor>{'─'.repeat(115)}</Text></Box>

      <ScrollHint side="above" count={overflowAbove} />

      {filtered.length === 0 && (
        <Box flexShrink={0}>
          <Text color="gray" dimColor>
            {allRoutes.length === 0
              ? 'No routes yet. Configure keys on the API keys screen (esc → back).'
              : `No routes match "${query}". Try a family name (glm, kimi, gpt) or a version.`}
          </Text>
        </Box>
      )}

      {filtered.slice(windowStart, windowEnd).map((route, offset) => {
        const i = windowStart + offset;
        const active = i === cursor;
        const picked = pickedRouteIds.has(route.id);
        const check = picked ? '●' : '○';
        return (
          <Box key={route.id} flexShrink={0}>
            <Box width={4}>
              {active ? <Text color="cyan" bold>▸ </Text> : <Text>  </Text>}
              <Text color={picked ? '#22c55e' : '#64748b'}>{check}</Text>
            </Box>
            <Box width={54}>
              <Text color={active ? 'white' : familyColor(route.family)} bold={active}>{truncate(route.displayName, 52)}</Text>
            </Box>
            <Box width={18}>
              <Text color={providerBadgeColor(route.providerSlug)}>{route.providerDisplayName}</Text>
            </Box>
            <Text color="gray">
              {formatPrice(route.inputPrice)} · {formatPrice(route.outputPrice)}
            </Text>
          </Box>
        );
      })}

      <ScrollHint side="below" count={overflowBelow} />
    </Frame>
  );
}

function providerBadgeColor(providerSlug: string): string {
  if (providerSlug === 'openrouter') return '#22d3ee';
  if (providerSlug === 'vercel') return '#60a5fa';
  if (providerSlug === 'cloudflare') return '#f97316';
  if (providerSlug.startsWith('direct:')) return '#a78bfa';
  return 'gray';
}

function formatPrice(v: number | null): string {
  if (v == null) return '  —  ';
  return `$${v.toFixed(2).padStart(5)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

function sanitizeInput(input: string): string {
  if (!input) return '';
  return input
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}
