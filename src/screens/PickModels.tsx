import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { TOP_MODELS, OTHER_MODELS, ALL_MODELS, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor, changeColor } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

const PRESETS: { key: string; label: string; slugs: string[] }[] = [
  { key: '1', label: 'Cheap coding fleet',      slugs: ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.2', 'qwen/qwen-3-coder'] },
  { key: '2', label: 'Frontier comparison',     slugs: ['anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-4.6', 'openai/gpt-5', 'google/gemini-3-flash'] },
  { key: '3', label: 'Free-tier only',          slugs: ALL_MODELS.filter((m) => m.isFree).map((m) => m.slug) },
];

export function PickModels() {
  const selectedModels = useStore((s) => s.selectedModels);
  const toggleModel = useStore((s) => s.toggleModel);
  const setPreset = useStore((s) => s.setPreset);
  const tasks = useStore((s) => s.tasks);
  const repeats = useStore((s) => s.repeats);
  const goTo = useStore((s) => s.goTo);
  const [cursor, setCursor] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.toLowerCase();
    const filter = (m: (typeof TOP_MODELS)[0]) => !q || m.slug.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q);
    return [
      { kind: 'header', label: 'Most used on OpenRouter (today)' } as const,
      ...TOP_MODELS.filter(filter).map((m) => ({ kind: 'model' as const, model: m })),
      { kind: 'header', label: 'All models (alphabetical)' } as const,
      ...OTHER_MODELS.filter(filter).map((m) => ({ kind: 'model' as const, model: m })),
    ];
  }, [query]);

  const modelRows = rows.filter((r) => r.kind === 'model') as { kind: 'model'; model: (typeof TOP_MODELS)[0] }[];

  useInput((input, key) => {
    if (searching) {
      if (key.return || key.escape) { setSearching(false); return; }
      if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setQuery((q) => q + input);
      return;
    }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(modelRows.length - 1, c + 1));
    else if (input === ' ' && modelRows[cursor]) toggleModel(modelRows[cursor].model.slug);
    else if (input === '/') setSearching(true);
    else if (input === '1' || input === '2' || input === '3') {
      const preset = PRESETS.find((p) => p.key === input);
      if (preset) setPreset(preset.slugs);
    }
    else if (key.return) goTo('confirm');
    else if (input === 'b' || key.escape) goTo('pickTasks');
  });

  const includedTasks = tasks.filter((t) => t.included);
  const estCost = useMemo(() => {
    let total = 0;
    for (const slug of selectedModels) {
      const m = ALL_MODELS.find((x) => x.slug === slug);
      if (!m) continue;
      const perRun = (BASELINE_INPUT_TOKENS / 1_000_000) * m.inputPrice + (BASELINE_OUTPUT_TOKENS / 1_000_000) * m.outputPrice;
      total += perRun * includedTasks.length * repeats;
    }
    total += JUDGE_COST_PER_TASK * includedTasks.length * selectedModels.size * repeats;
    return total;
  }, [selectedModels, includedTasks.length, repeats]);

  return (
    <Frame
      title="my-agent-repo · Pick models"
      accent={SCREEN_ACCENT.pickModels}
      subtitle={`${selectedModels.size} selected · ${includedTasks.length} tasks × ${repeats} repeats ≈ $${estCost.toFixed(2)}`}
      footer={
        <Box flexDirection="column">
          <Text color="gray">
            <Text color="cyan">↑↓</Text> nav · <Text color="cyan">space</Text> toggle · <Text color="cyan">/</Text> search · <Text color="cyan">1</Text> cheap · <Text color="cyan">2</Text> frontier · <Text color="cyan">3</Text> free · <Text color="cyan">enter</Text> next → · <Text color="cyan">b</Text> back
          </Text>
          {searching && <Text color="cyan">Search: <Text color="white" bold>{query}</Text><Text color="gray">▏</Text></Text>}
        </Box>
      }
    >
      {(() => {
        let modelIdx = -1;
        return rows.map((row, i) => {
          if (row.kind === 'header') {
            return (
              <Box key={`h${i}`} marginTop={i === 0 ? 0 : 1}>
                <Text color="magenta" bold>{row.label}</Text>
              </Box>
            );
          }
          modelIdx++;
          const active = modelIdx === cursor;
          const m = row.model;
          const check = selectedModels.has(m.slug) ? '●' : '○';
          const rankStr = m.rankPosition ? String(m.rankPosition).padStart(2, ' ') : '  ';
          const tokensStr = m.totalTokens ? formatTokens(m.totalTokens).padStart(9) : '         ';
          return (
            <Box key={m.slug} paddingLeft={active ? 0 : 2}>
              {active && <Text color="cyan" bold>▸ </Text>}
              <Text color={selectedModels.has(m.slug) ? '#22c55e' : 'gray'}>{check} </Text>
              <Box width={4}><Text color="gray">{rankStr}</Text></Box>
              <Box width={22}><Text color={familyColor(m.family)} bold>{truncate(m.displayName, 20)}</Text></Box>
              <Box width={10}><Text color={changeColor(m.changePct)}>{m.rankPosition ? `${m.changePct > 0 ? '↑' : m.changePct < 0 ? '↓' : ' '}${Math.abs(m.changePct)}%` : ''}</Text></Box>
              <Box width={12}><Text color="gray">{tokensStr}</Text></Box>
              <Text color="gray">${m.inputPrice.toFixed(2).padStart(5)}/${m.outputPrice.toFixed(2).padStart(5)} · </Text>
              <Text color="gray">{(m.context / 1000).toFixed(0)}k ctx</Text>
              {m.isFree && <Text color="#22c55e"> free</Text>}
            </Box>
          );
        });
      })()}
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
