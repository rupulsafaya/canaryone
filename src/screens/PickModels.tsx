import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { TOP_MODELS, OTHER_MODELS, ALL_MODELS, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, getDestinations } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor, changeColor } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import { ScrollHint } from '../components/ScrollHint.tsx';
import { useScrollWindow, useTerminalDimensions } from '../hooks/useScrollWindow.ts';

export function PickModels() {
  const selectedModels = useStore((s) => s.selectedModels);
  const selectedDestinations = useStore((s) => s.selectedDestinations);
  const toggleModel = useStore((s) => s.toggleModel);
  const tasks = useStore((s) => s.tasks);
  const repeats = useStore((s) => s.repeats);
  const goTo = useStore((s) => s.goTo);
  const [cursor, setCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  type Row = { kind: 'header'; label: string } | { kind: 'model'; model: (typeof TOP_MODELS)[0] } | { kind: 'hint'; label: string };
  const rows: Row[] = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) {
      return [
        { kind: 'header', label: 'Most used on OpenRouter (today)' },
        ...TOP_MODELS.map((m) => ({ kind: 'model', model: m } as const)),
        { kind: 'hint', label: `${OTHER_MODELS.length} more models · press / to search across all ${ALL_MODELS.length}` },
      ];
    }
    const matching = ALL_MODELS.filter((m) => m.slug.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q));
    return [
      { kind: 'header', label: `Search results (${matching.length} of ${ALL_MODELS.length})` },
      ...matching.map((m) => ({ kind: 'model', model: m } as const)),
    ];
  }, [query]);

  const modelRows = rows.filter((r) => r.kind === 'model') as Extract<Row, { kind: 'model' }>[];
  const modelRowIndices = useMemo(() => rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'model').map((x) => x.i), [rows]);
  const [, termRows] = useTerminalDimensions();
  // Chrome: border(2) + title(1) + margin(1) + col headers(1) + divider(1) + footer(3) + scroll hints(2) = ~11
  const visibleRows = Math.max(6, termRows - 11);
  const focusedRowIdx = modelRowIndices[cursor] ?? 0;
  const { windowStart, windowEnd, overflowAbove, overflowBelow } = useScrollWindow(rows.length, focusedRowIdx, visibleRows);

  useInput((input, key) => {
    if (searching) {
      if (key.return || key.escape) { setSearching(false); return; }
      if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setCursor(0); return; }
      if (input && !key.ctrl && !key.meta) { setQuery((q) => q + input); setCursor(0); }
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(Math.max(0, modelRows.length - 1), c + 1));
    else if (input === ' ' && modelRows[cursor]) toggleModel(modelRows[cursor].model.slug);
    else if (input === '/') setSearching(true);
    else if (key.return) goTo('pickDestinations');
    else if (input === 'b' || key.escape) goTo('pickTasks');
  });

  const includedTasks = tasks.filter((t) => t.included);
  const totalLanes = useMemo(() => {
    let n = 0;
    for (const m of selectedModels) n += (selectedDestinations[m]?.size ?? 0);
    return n;
  }, [selectedModels, selectedDestinations]);

  const estCost = useMemo(() => {
    let total = 0;
    for (const slug of selectedModels) {
      const dests = selectedDestinations[slug] ?? new Set<string>();
      for (const destSlug of dests) {
        const d = getDestinations(slug).find((x) => x.slug === destSlug);
        const inP = d?.inputPrice ?? ALL_MODELS.find((m) => m.slug === slug)?.inputPrice ?? 0;
        const outP = d?.outputPrice ?? ALL_MODELS.find((m) => m.slug === slug)?.outputPrice ?? 0;
        total += ((BASELINE_INPUT_TOKENS / 1_000_000) * inP + (BASELINE_OUTPUT_TOKENS / 1_000_000) * outP) * includedTasks.length * repeats;
      }
    }
    total += JUDGE_COST_PER_TASK * includedTasks.length * totalLanes * repeats;
    return total;
  }, [selectedModels, selectedDestinations, includedTasks.length, repeats, totalLanes]);

  return (
    <Frame
      title="Pick models"
      accent={SCREEN_ACCENT.pickModels}
      subtitle={`${selectedModels.size} models · ${totalLanes} lanes · ${includedTasks.length} tasks × ${repeats} rpts ≈ $${estCost.toFixed(2)}`}
      footer={
        <Box flexDirection="column">
          <Text color="gray">
            <Text color="cyan">↑↓</Text> nav · <Text color="cyan">space</Text> toggle · <Text color="cyan">/</Text> search · <Text color="cyan">enter</Text> pick destinations → · <Text color="cyan">b</Text> back
          </Text>
          {searching && <Text color="cyan">Search: <Text color="white" bold>{query}</Text><Text color="gray">▏</Text><Text color="gray"> · enter/esc close</Text></Text>}
        </Box>
      }
    >
      <Box flexShrink={0}>
        <Box width={4}><Text color="magenta" bold>   </Text></Box>
        <Box width={4}><Text color="magenta" bold>#</Text></Box>
        <Box width={22}><Text color="magenta" bold>Model</Text></Box>
        <Box width={10}><Text color="magenta" bold>Δ 24h</Text></Box>
        <Box width={12}><Text color="magenta" bold>Tokens/day</Text></Box>
        <Box width={16}><Text color="magenta" bold>$/M in · out</Text></Box>
        <Box width={9}><Text color="magenta" bold>Ctx</Text></Box>
        <Text color="magenta" bold>Free</Text>
      </Box>
      <Box flexShrink={0}><Text color="gray" dimColor>{'─'.repeat(95)}</Text></Box>

      <ScrollHint side="above" count={overflowAbove} />

      {(() => {
        const windowed = rows.slice(windowStart, windowEnd);
        return windowed.map((row, offset) => {
          const i = windowStart + offset;
          if (row.kind === 'header') {
            return (
              <Box key={`h${i}`} marginTop={i === 0 || offset === 0 ? 0 : 1} flexShrink={0}>
                <Text color="cyan" bold>▸ {row.label}</Text>
              </Box>
            );
          }
          if (row.kind === 'hint') {
            return (
              <Box key={`hint${i}`} marginTop={1} flexShrink={0}>
                <Text color="gray" dimColor>… {row.label}</Text>
              </Box>
            );
          }
          const active = i === focusedRowIdx;
          const m = row.model;
          const check = selectedModels.has(m.slug) ? '●' : '○';
          const rankStr = m.rankPosition ? String(m.rankPosition).padStart(2, ' ') : '  ';
          const tokensStr = m.totalTokens ? formatTokens(m.totalTokens).padStart(9) : '        —';
          return (
            <Box key={m.slug} flexShrink={0}>
              <Box width={4}>
                {active ? <Text color="cyan" bold>▸ </Text> : <Text>  </Text>}
                <Text color={selectedModels.has(m.slug) ? '#22c55e' : '#64748b'}>{check}</Text>
              </Box>
              <Box width={4}><Text color="gray">{rankStr}</Text></Box>
              <Box width={22}><Text color={familyColor(m.family)} bold>{truncate(m.displayName, 20)}</Text></Box>
              <Box width={10}><Text color={changeColor(m.changePct)}>{m.rankPosition ? `${m.changePct > 0 ? '↑' : m.changePct < 0 ? '↓' : ' '}${Math.abs(m.changePct)}%` : ' '}</Text></Box>
              <Box width={12}><Text color="gray">{tokensStr}</Text></Box>
              <Box width={16}><Text color="gray">${m.inputPrice.toFixed(2).padStart(5)} · ${m.outputPrice.toFixed(2).padStart(5)}</Text></Box>
              <Box width={9}><Text color="gray">{(m.context / 1000).toFixed(0)}k</Text></Box>
              {m.isFree ? <Text color="#22c55e" bold>free</Text> : <Text color="gray"> </Text>}
            </Box>
          );
        });
      })()}

      <ScrollHint side="below" count={overflowBelow} />
    </Frame>
  );
}

function formatTokens(n: number) {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(0) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + 'M';
  return String(n);
}
function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}
