import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { ALL_MODELS, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, P50_RUN_SECONDS } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

export function Confirm() {
  const tasks = useStore((s) => s.tasks);
  const selectedModels = useStore((s) => s.selectedModels);
  const repeats = useStore((s) => s.repeats);
  const parallelism = useStore((s) => s.parallelism);
  const maxSpend = useStore((s) => s.maxSpend);
  const goTo = useStore((s) => s.goTo);
  const startRun = useStore((s) => s.startRun);

  useInput((input, key) => {
    if (key.return) startRun();
    else if (input === 't') goTo('pickTasks');
    else if (input === 'm') goTo('pickModels');
    else if (input === 'q' || key.escape) process.exit(0);
  });

  const includedTasks = tasks.filter((t) => t.included);
  const modelObjs = Array.from(selectedModels).map((s) => ALL_MODELS.find((m) => m.slug === s)!).filter(Boolean);
  const totalRuns = includedTasks.length * modelObjs.length * repeats;
  const seqSec = totalRuns * P50_RUN_SECONDS;
  const parSec = Math.max(P50_RUN_SECONDS, seqSec / Math.min(parallelism, modelObjs.length));

  let destCost = 0;
  for (const m of modelObjs) {
    destCost += ((BASELINE_INPUT_TOKENS / 1_000_000) * m.inputPrice + (BASELINE_OUTPUT_TOKENS / 1_000_000) * m.outputPrice) * includedTasks.length * repeats;
  }
  const judgeCost = JUDGE_COST_PER_TASK * includedTasks.length * modelObjs.length * repeats;
  const totalCost = destCost + judgeCost;
  const overCap = totalCost > maxSpend;

  return (
    <Frame
      title="my-agent-repo · Confirm & run"
      accent={SCREEN_ACCENT.confirm}
      footer={
        <Text color="gray">
          <Text color="#22c55e" bold>enter</Text> RUN · <Text color="cyan">t</Text> change tasks · <Text color="cyan">m</Text> change models · <Text color="cyan">q</Text> quit
        </Text>
      }
    >
      <Section title="Scope">
        <Text>
          <Text color="white" bold>{includedTasks.length}</Text> tasks × <Text color="white" bold>{modelObjs.length}</Text> models × <Text color="white" bold>1</Text> provider (OR) × <Text color="white" bold>{repeats}</Text> repeats = <Text color="cyan" bold>{totalRuns} runs</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray" dimColor>models:</Text>
          {modelObjs.map((m) => (
            <Text key={m.slug}>  <Text color={familyColor(m.family)}>●</Text> {m.displayName} <Text color="gray">· ${m.inputPrice.toFixed(2)}/${m.outputPrice.toFixed(2)} per 1M</Text></Text>
          ))}
        </Box>
      </Section>

      <Section title="Time">
        <Text>~ <Text color="white" bold>{fmtDuration(seqSec)}</Text> sequential · with parallelism={parallelism}: <Text color="cyan" bold>~ {fmtDuration(parSec)}</Text> wall-clock</Text>
      </Section>

      <Section title="Cost">
        <KV label="Destination LLM (OR list × baseline tokens)" value={`~ $${destCost.toFixed(2)}`} />
        <KV label={`Judge model ($${JUDGE_COST_PER_TASK.toFixed(3)} × ${totalRuns} tasks judged)`} value={`~ $${judgeCost.toFixed(2)}`} />
        <Box marginTop={0}><Text color="gray">  ─────────────────────────────────────────────────────</Text></Box>
        <KV label="Total estimated" value={`~ $${totalCost.toFixed(2)}`} highlight color={overCap ? '#ef4444' : '#22c55e'} />
        <Box marginTop={1}>
          <Text color={overCap ? '#ef4444' : 'gray'}>Guardrail: hard cap at <Text bold>${maxSpend.toFixed(2)}</Text> (--max-spend override){overCap ? ' · OVER CAP · adjust selection or raise cap' : ''}</Text>
        </Box>
      </Section>
    </Frame>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
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
