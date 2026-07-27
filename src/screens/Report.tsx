import React from 'react';
import { Box, Text, useInput } from 'ink';
import Gradient from 'ink-gradient';
import { useStore } from '../state/store.js';
import { ALL_MODELS } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor, COST_BUCKETS, costGradient } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

export function Report() {
  const tasks = useStore((s) => s.tasks);
  const selectedModels = useStore((s) => s.selectedModels);
  const cells = useStore((s) => s.cells);
  const totalSpend = useStore((s) => s.totalSpend);
  const goTo = useStore((s) => s.goTo);
  const reset = useStore((s) => s.reset);

  useInput((input) => {
    if (input === 'r') { reset(); goTo('pickTasks'); }
    else if (input === 'q') process.exit(0);
    else if (input === 'o') { /* pretend to open browser */ }
  });

  const includedTasks = tasks.filter((t) => t.included);
  const modelSlugs = Array.from(selectedModels);

  // Compute $/pass per model
  const perModel = modelSlugs.map((slug) => {
    const modelCells = cells[slug] ?? {};
    const passed = includedTasks.filter((t) => modelCells[t.id]?.state === 'passed').length;
    const spend = includedTasks.reduce((a, t) => a + (modelCells[t.id]?.costUsd ?? 0), 0);
    const costPerPass = passed > 0 ? spend / passed : Infinity;
    return { slug, passed, attempted: includedTasks.length, spend, costPerPass };
  });
  const cheapestPerPass = Math.min(...perModel.filter((m) => isFinite(m.costPerPass)).map((m) => m.costPerPass));

  return (
    <Frame
      title="my-agent-repo · Report"
      accent={SCREEN_ACCENT.report}
      subtitle={`total spend $${totalSpend.toFixed(2)} · saved to .c1/reports/2026-07-27T19-30-00Z/`}
      footer={
        <Text color="gray">
          <Text color="cyan">o</Text> open index.html · <Text color="cyan">r</Text> run again · <Text color="cyan">q</Text> quit
        </Text>
      }
    >
      <Box justifyContent="center">
        <Gradient name="fruit"><Text bold>Cost per outcome heatmap</Text></Gradient>
      </Box>

      {/* Color legend */}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color="gray" dimColor>$/pass cell color: </Text>
          {COST_BUCKETS.map((b, i) => (
            <Box key={i}>
              <Text color={b.color}>██ </Text>
              <Text color="gray">{b.label}   </Text>
            </Box>
          ))}
        </Box>
        <Box>
          <Text color="gray" dimColor>state: </Text>
          <Text color="#22c55e">██ </Text><Text color="gray">passed (colored by $/pass)   </Text>
          <Text color="#ef4444">▒▒ </Text><Text color="gray">failed   </Text>
          <Text color="#f97316">▚▚ </Text><Text color="gray">infra-error   </Text>
          <Text color="#3f3f46">·· </Text><Text color="gray">not run</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Box width={24}><Text> </Text></Box>
        {includedTasks.map((t) => (
          <Box key={t.id} width={4}><Text color="gray" bold>{t.id}</Text></Box>
        ))}
        <Box paddingLeft={2}>
          <Box width={12}><Text color="gray" bold>$/pass</Text></Box>
          <Box width={10}><Text color="gray" bold>pass</Text></Box>
          <Box width={9}><Text color="gray" bold>spend</Text></Box>
        </Box>
      </Box>

      {perModel.map(({ slug, passed, attempted, spend, costPerPass }) => {
        const model = ALL_MODELS.find((m) => m.slug === slug)!;
        const modelCells = cells[slug] ?? {};
        const winner = costPerPass === cheapestPerPass;
        return (
          <Box key={slug}>
            <Box width={24}>
              <Text color={familyColor(model.family)} bold>{winner ? '★ ' : '  '}</Text>
              <Text color={familyColor(model.family)}>{truncate(model.displayName, 20)}</Text>
            </Box>
            {includedTasks.map((t) => {
              const cell = modelCells[t.id];
              const state = cell?.state ?? 'queued';
              const symbol = state === 'passed' ? '██' : state === 'failed' ? '▒▒' : state === 'error' ? '▚▚' : '··';
              const color = state === 'passed' ? costGradient(cell?.costUsd ?? 0) : state === 'failed' ? '#ef4444' : state === 'error' ? '#f97316' : '#3f3f46';
              return (
                <Box key={t.id} width={4}>
                  <Text color={color}>{symbol} </Text>
                </Box>
              );
            })}
            <Box paddingLeft={2}>
              <Box width={12}><Text color={winner ? '#22c55e' : 'white'} bold={winner}>{isFinite(costPerPass) ? `$${costPerPass.toFixed(3)}` : '—'}</Text></Box>
              <Box width={10}><Text color="gray">{passed}/{attempted}</Text></Box>
              <Box width={9}><Text color="gray">${spend.toFixed(2)}</Text></Box>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Saved:</Text>
        <Text color="cyan">  .c1/reports/2026-07-27T19-30-00Z/index.html</Text>
        <Text color="cyan">  .c1/reports/2026-07-27T19-30-00Z/summary.md</Text>
        <Text color="cyan">  .c1/reports/2026-07-27T19-30-00Z/heatmap.png</Text>
        <Text color="cyan">  .c1/reports/2026-07-27T19-30-00Z/raw.jsonl</Text>
      </Box>
    </Frame>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}
