import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { ALL_MODELS, getHosts, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

// Flat list of {header, host} rows built from selected models. Only hosts are selectable.
type Row =
  | { kind: 'model'; modelSlug: string }
  | { kind: 'host'; modelSlug: string; hostSlug: string };

export function PickHosts() {
  const selectedModels = useStore((s) => s.selectedModels);
  const selectedHosts = useStore((s) => s.selectedHosts);
  const toggleHost = useStore((s) => s.toggleHost);
  const tasks = useStore((s) => s.tasks);
  const repeats = useStore((s) => s.repeats);
  const goTo = useStore((s) => s.goTo);
  const [cursor, setCursor] = useState(0);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const model of selectedModels) {
      out.push({ kind: 'model', modelSlug: model });
      for (const host of getHosts(model)) {
        out.push({ kind: 'host', modelSlug: model, hostSlug: host.slug });
      }
    }
    return out;
  }, [selectedModels]);

  const hostRows = useMemo(() => rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'host'), [rows]);

  useInput((input, key) => {
    if (key.upArrow) {
      const cur = hostRows[cursor];
      if (!cur) return;
      const prev = hostRows[Math.max(0, cursor - 1)];
      setCursor(hostRows.indexOf(prev));
    }
    else if (key.downArrow) setCursor((c) => Math.min(hostRows.length - 1, c + 1));
    else if (input === ' ') {
      const r = hostRows[cursor]?.r;
      if (r?.kind === 'host') toggleHost(r.modelSlug, r.hostSlug);
    }
    else if (key.return) goTo('confirm');
    else if (input === 'b' || key.escape) goTo('pickModels');
  });

  const totalLanes = useMemo(() => {
    let n = 0;
    for (const m of selectedModels) n += (selectedHosts[m]?.size ?? 0);
    return n;
  }, [selectedModels, selectedHosts]);

  const includedTasks = tasks.filter((t) => t.included);
  const estCost = useMemo(() => {
    let total = 0;
    for (const model of selectedModels) {
      const hosts = selectedHosts[model] ?? new Set<string>();
      for (const hostSlug of hosts) {
        const h = getHosts(model).find((x) => x.slug === hostSlug);
        if (!h) continue;
        total += ((BASELINE_INPUT_TOKENS / 1_000_000) * h.inputPrice + (BASELINE_OUTPUT_TOKENS / 1_000_000) * h.outputPrice) * includedTasks.length * repeats;
      }
    }
    total += JUDGE_COST_PER_TASK * includedTasks.length * totalLanes * repeats;
    return total;
  }, [selectedModels, selectedHosts, includedTasks.length, repeats, totalLanes]);

  const focusedHostIdx = hostRows[cursor]?.i;

  return (
    <Frame
      title="Pick hosts (per model)"
      accent={SCREEN_ACCENT.pickModels}
      subtitle={`${totalLanes} lanes · ${includedTasks.length} tasks × ${repeats} rpts ≈ $${estCost.toFixed(2)}`}
      footer={
        <Text color="gray">
          <Text color="cyan">↑↓</Text> nav hosts · <Text color="cyan">space</Text> toggle · <Text color="cyan">enter</Text> confirm & run → · <Text color="cyan">b</Text> back
        </Text>
      }
    >
      <Box flexShrink={0}>
        <Text color="gray" dimColor>Each selected (model, host) pair becomes one lane in the run. Same model across N hosts = N lanes = N-way host comparison.</Text>
      </Box>
      <Box marginTop={1} />

      <Box flexShrink={0}>
        <Box width={6}><Text color="magenta" bold>   </Text></Box>
        <Box width={28}><Text color="magenta" bold>Model / Host</Text></Box>
        <Box width={16}><Text color="magenta" bold>$/M in · out</Text></Box>
        <Text color="magenta" bold>Notes</Text>
      </Box>
      <Box flexShrink={0}><Text color="gray" dimColor>{'─'.repeat(80)}</Text></Box>

      {rows.map((row, i) => {
        if (row.kind === 'model') {
          const model = ALL_MODELS.find((m) => m.slug === row.modelSlug);
          if (!model) return null;
          const hosts = getHosts(row.modelSlug);
          const picked = selectedHosts[row.modelSlug]?.size ?? 0;
          return (
            <Box key={`m${i}`} marginTop={i === 0 ? 0 : 1} flexShrink={0}>
              <Box width={6}><Text color={familyColor(model.family)} bold>●   </Text></Box>
              <Box width={28}><Text color={familyColor(model.family)} bold>{model.displayName}</Text></Box>
              <Text color="gray" dimColor>{picked} of {hosts.length} host{hosts.length === 1 ? '' : 's'} · {picked === 0 ? 'NO LANE (add ≥1 host)' : `${picked} lane${picked === 1 ? '' : 's'}`}</Text>
            </Box>
          );
        }
        // host row
        const host = getHosts(row.modelSlug).find((h) => h.slug === row.hostSlug);
        if (!host) return null;
        const active = i === focusedHostIdx;
        const isPicked = selectedHosts[row.modelSlug]?.has(row.hostSlug);
        const check = isPicked ? '●' : '○';
        return (
          <Box key={`h${i}`} flexShrink={0}>
            <Box width={6}>
              <Text>   </Text>
              {active ? <Text color="cyan" bold>▸ </Text> : <Text>  </Text>}
              <Text color={isPicked ? '#22c55e' : '#64748b'}>{check}</Text>
            </Box>
            <Box width={28}>
              <Text color={active ? 'white' : 'gray'} bold={active}>{host.displayName}</Text>
              {host.isFirstParty && <Text color="#a78bfa" dimColor> ★</Text>}
            </Box>
            <Box width={16}><Text color="gray">${host.inputPrice.toFixed(2).padStart(5)} · ${host.outputPrice.toFixed(2).padStart(5)}</Text></Box>
            <Text color="gray" dimColor>{host.isFirstParty ? 'first-party' : ''}</Text>
          </Box>
        );
      })}
    </Frame>
  );
}
