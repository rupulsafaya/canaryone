import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { ALL_MODELS, getDestinations, isDestinationAvailable, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, Router } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

type Row =
  | { kind: 'model'; modelSlug: string }
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

export function PickDestinations() {
  const selectedModels = useStore((s) => s.selectedModels);
  const selectedDestinations = useStore((s) => s.selectedDestinations);
  const toggleDestination = useStore((s) => s.toggleDestination);
  const tasks = useStore((s) => s.tasks);
  const repeats = useStore((s) => s.repeats);
  const goTo = useStore((s) => s.goTo);
  const [cursor, setCursor] = useState(0);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const model of selectedModels) {
      out.push({ kind: 'model', modelSlug: model });
      for (const d of getDestinations(model)) {
        out.push({ kind: 'destination', modelSlug: model, destSlug: d.slug });
      }
    }
    return out;
  }, [selectedModels]);

  const destRows = useMemo(
    () => rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'destination'),
    [rows]
  );

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(destRows.length - 1, c + 1));
    else if (input === ' ') {
      const r = destRows[cursor]?.r;
      if (r?.kind === 'destination') toggleDestination(r.modelSlug, r.destSlug);
    }
    else if (key.return) goTo('confirm');
    else if (input === 'b' || key.escape) goTo('pickModels');
  });

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
      for (const destSlug of dests) {
        const d = getDestinations(model).find((x) => x.slug === destSlug);
        if (!d) continue;
        total += ((BASELINE_INPUT_TOKENS / 1_000_000) * d.inputPrice + (BASELINE_OUTPUT_TOKENS / 1_000_000) * d.outputPrice) * includedTasks.length * repeats;
      }
    }
    total += JUDGE_COST_PER_TASK * includedTasks.length * totalLanes * repeats;
    return total;
  }, [selectedModels, selectedDestinations, includedTasks.length, repeats, totalLanes]);

  const focusedDestIdx = destRows[cursor]?.i;

  return (
    <Frame
      title="Pick destinations (per model)"
      accent={SCREEN_ACCENT.pickModels}
      subtitle={`${totalLanes} lanes · ${includedTasks.length} tasks × ${repeats} rpts ≈ $${estCost.toFixed(2)}`}
      footer={
        <Text color="gray">
          <Text color="cyan">↑↓</Text> nav · <Text color="cyan">space</Text> toggle · <Text color="cyan">enter</Text> confirm → · <Text color="cyan">b</Text> back
        </Text>
      }
    >
      <Box flexShrink={0}>
        <Text color="gray" dimColor>Each (model, destination) is a lane. Destination = router + provider. Preview rows require your own key (e.g. NEBIUS_KEY) — direct/other-router adapters land v0.1+.</Text>
      </Box>
      <Box marginTop={1} flexShrink={0} />

      <Box flexShrink={0}>
        <Box width={6}><Text color="magenta" bold>   </Text></Box>
        <Box width={26}><Text color="magenta" bold>Model / Provider</Text></Box>
        <Box width={12}><Text color="magenta" bold>Router</Text></Box>
        <Box width={16}><Text color="magenta" bold>$/M in · out</Text></Box>
        <Text color="magenta" bold>Notes</Text>
      </Box>
      <Box flexShrink={0}><Text color="gray" dimColor>{'─'.repeat(90)}</Text></Box>

      {rows.map((row, i) => {
        if (row.kind === 'model') {
          const model = ALL_MODELS.find((m) => m.slug === row.modelSlug);
          if (!model) return null;
          const all = getDestinations(row.modelSlug);
          const picked = selectedDestinations[row.modelSlug]?.size ?? 0;
          return (
            <Box key={`m${i}`} marginTop={i === 0 ? 0 : 1} flexShrink={0}>
              <Box width={6}><Text color={familyColor(model.family)} bold>●   </Text></Box>
              <Box width={26}><Text color={familyColor(model.family)} bold>{model.displayName}</Text></Box>
              <Text color="gray" dimColor>{picked} of {all.length} destination{all.length === 1 ? '' : 's'} · {picked === 0 ? 'NO LANE (pick ≥1)' : `${picked} lane${picked === 1 ? '' : 's'}`}</Text>
            </Box>
          );
        }
        const dest = getDestinations(row.modelSlug).find((d) => d.slug === row.destSlug);
        if (!dest) return null;
        const active = i === focusedDestIdx;
        const isPicked = selectedDestinations[row.modelSlug]?.has(row.destSlug);
        const available = isDestinationAvailable(dest);
        const check = isPicked ? '●' : '○';
        const dim = !available;
        return (
          <Box key={`d${i}`} flexShrink={0}>
            <Box width={6}>
              <Text>   </Text>
              {active ? <Text color="cyan" bold>▸ </Text> : <Text>  </Text>}
              <Text color={isPicked ? '#22c55e' : available ? '#64748b' : '#3f3f46'} dimColor={dim}>{check}</Text>
            </Box>
            <Box width={26}>
              <Text color={active ? 'white' : 'gray'} bold={active} dimColor={dim}>{truncate(dest.displayName, 22)}</Text>
              {dest.isFirstParty && <Text color="#a78bfa" dimColor> ★</Text>}
            </Box>
            <Box width={12}>
              <Text color={ROUTER_COLOR[dest.router]} dimColor={dim}>{ROUTER_LABEL[dest.router]}</Text>
            </Box>
            <Box width={16}><Text color="gray" dimColor={dim}>${dest.inputPrice.toFixed(2).padStart(5)} · ${dest.outputPrice.toFixed(2).padStart(5)}</Text></Box>
            <Text color="gray" dimColor>
              {dest.isPreview && dest.requiresKey && !available ? <Text color="#f97316">requires {dest.requiresKey} (v0.1 preview)</Text> :
               dest.isPreview ? <Text color="#f97316">v0.1 preview</Text> :
               dest.isFirstParty ? 'first-party' : ''}
            </Text>
          </Box>
        );
      })}
    </Frame>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}
