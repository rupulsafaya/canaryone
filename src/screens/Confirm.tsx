import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { ALL_MODELS, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, P50_RUN_SECONDS, getDestinations } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

export function Confirm() {
  const tasks = useStore((s) => s.tasks);
  const selectedModels = useStore((s) => s.selectedModels);
  const selectedDestinations = useStore((s) => s.selectedDestinations);
  const repeats = useStore((s) => s.repeats);
  const parallelism = useStore((s) => s.parallelism);
  const maxSpend = useStore((s) => s.maxSpend);
  const setMaxSpend = useStore((s) => s.setMaxSpend);
  const goTo = useStore((s) => s.goTo);
  const startRun = useStore((s) => s.startRun);
  const [editingCap, setEditingCap] = useState(false);
  const [capDraft, setCapDraft] = useState(maxSpend.toFixed(2));

  useInput((input, key) => {
    if (editingCap) {
      if (key.return) {
        const v = parseFloat(capDraft);
        if (!isNaN(v) && v > 0) setMaxSpend(v);
        setEditingCap(false);
        return;
      }
      if (key.escape) { setEditingCap(false); setCapDraft(maxSpend.toFixed(2)); return; }
      if (key.backspace || key.delete) { setCapDraft((d) => d.slice(0, -1)); return; }
      if (input && /^[\d.]$/.test(input)) setCapDraft((d) => d + input);
      return;
    }
    if (key.return) startRun();
    else if (input === 't') goTo('pickTasks');
    else if (input === 'm') goTo('pickModels');
    else if (input === 'h') goTo('pickDestinations');
    else if (input === 'c') { setCapDraft(maxSpend.toFixed(2)); setEditingCap(true); }
    else if (input === 'q' || key.escape) process.exit(0);
  });

  const includedTasks = tasks.filter((t) => t.included);
  const lanes: { model: string; dest: string; router: string; inputPrice: number; outputPrice: number }[] = [];
  for (const model of selectedModels) {
    const dests = selectedDestinations[model] ?? new Set<string>();
    for (const destSlug of dests) {
      const d = getDestinations(model).find((x) => x.slug === destSlug);
      if (!d) continue;
      lanes.push({ model, dest: destSlug, router: d.router, inputPrice: d.inputPrice, outputPrice: d.outputPrice });
    }
  }
  const totalRuns = includedTasks.length * lanes.length * repeats;
  const seqSec = totalRuns * P50_RUN_SECONDS;
  const parSec = Math.max(P50_RUN_SECONDS, seqSec / Math.min(parallelism, lanes.length || 1));

  let destCost = 0;
  for (const l of lanes) {
    destCost += ((BASELINE_INPUT_TOKENS / 1_000_000) * l.inputPrice + (BASELINE_OUTPUT_TOKENS / 1_000_000) * l.outputPrice) * includedTasks.length * repeats;
  }
  const judgeCost = JUDGE_COST_PER_TASK * includedTasks.length * lanes.length * repeats;
  const totalCost = destCost + judgeCost;
  const overCap = totalCost > maxSpend;

  return (
    <Frame
      title="Confirm & run"
      accent={SCREEN_ACCENT.confirm}
      footer={
        editingCap ? (
          <Text color="cyan">
            New cap ($): <Text color="white" bold>{capDraft}</Text><Text color="gray">▏</Text><Text color="gray"> · enter save · esc cancel</Text>
          </Text>
        ) : (
          <Text color="gray">
            {overCap
              ? <Text color="gray">enter <Text dimColor>(blocked, over cap)</Text></Text>
              : <Text color="#22c55e" bold>enter RUN</Text>}
            <Text color="gray"> · </Text><Text color="cyan">c</Text> cap · <Text color="cyan">t</Text> tasks · <Text color="cyan">m</Text> models · <Text color="cyan">h</Text> hosts · <Text color="cyan">q</Text> quit
          </Text>
        )
      }
    >
      <Section title="Scope">
        <Text>
          <Text color="white" bold>{includedTasks.length}</Text> tasks × <Text color="white" bold>{lanes.length}</Text> lanes (model,host) × <Text color="white" bold>{repeats}</Text> repeats = <Text color="cyan" bold>{totalRuns} runs</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray" dimColor>lanes:</Text>
          {lanes.slice(0, 8).map((l) => {
            const m = ALL_MODELS.find((x) => x.slug === l.model);
            if (!m) return null;
            return (
              <Text key={`${l.model}@${l.dest}`}>
                {'  '}<Text color={familyColor(m.family)}>●</Text> <Text color="white">{m.displayName}</Text> <Text color="gray">·</Text> <Text color="magenta">{l.dest.replace(/^[^:]+:/, '')}</Text> <Text color="gray">·</Text> <Text color="#22d3ee">{l.router}</Text> <Text color="gray">· ${l.inputPrice.toFixed(2)}/${l.outputPrice.toFixed(2)}/M</Text>
              </Text>
            );
          })}
          {lanes.length > 8 && <Text color="gray" dimColor>{'  '}+ {lanes.length - 8} more lanes</Text>}
        </Box>
      </Section>

      <Section title="Time">
        <Text>~ <Text color="white" bold>{fmtDuration(seqSec)}</Text> sequential · with parallelism={parallelism}: <Text color="cyan" bold>~ {fmtDuration(parSec)}</Text> wall-clock</Text>
      </Section>

      <Section title="Cost">
        <KV label="Destination LLM (per-host prices × baseline tokens)" value={`~ $${destCost.toFixed(2)}`} />
        <KV label={`Judge model ($${JUDGE_COST_PER_TASK.toFixed(3)} × ${totalRuns} tasks judged)`} value={`~ $${judgeCost.toFixed(2)}`} />
        <Box><Text color="gray">  ─────────────────────────────────────────────────────</Text></Box>
        <KV label="Total estimated" value={`~ $${totalCost.toFixed(2)}`} highlight color={overCap ? '#ef4444' : '#22c55e'} />
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">
            Guardrail: hard cap at <Text bold color={overCap ? '#ef4444' : 'white'}>${maxSpend.toFixed(2)}</Text> <Text color="gray" dimColor>(--max-spend override)</Text>
          </Text>
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
      <Box width={54}><Text color={highlight ? 'white' : 'gray'} bold={highlight}>{label}</Text></Box>
      <Text color={color ?? (highlight ? 'white' : 'gray')} bold={highlight}>{value}</Text>
    </Box>
  );
}
function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
