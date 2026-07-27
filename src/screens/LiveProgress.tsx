import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { ALL_MODELS, BASELINE_INPUT_TOKENS, BASELINE_OUTPUT_TOKENS, JUDGE_COST_PER_TASK, P50_RUN_SECONDS } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor, CELL_COLOR, CELL_GLYPH } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

export function LiveProgress() {
  const tasks = useStore((s) => s.tasks);
  const selectedModels = useStore((s) => s.selectedModels);
  const cells = useStore((s) => s.cells);
  const runStartedAt = useStore((s) => s.runStartedAt);
  const runFinishedAt = useStore((s) => s.runFinishedAt);
  const totalSpend = useStore((s) => s.totalSpend);
  const repeats = useStore((s) => s.repeats);
  const parallelism = useStore((s) => s.parallelism);
  const tick = useStore((s) => s.tick);
  const goTo = useStore((s) => s.goTo);

  useEffect(() => {
    if (runFinishedAt) return;
    const timer = setInterval(tick, 350);
    return () => clearInterval(timer);
  }, [runFinishedAt, tick]);

  useInput((input) => {
    if (runFinishedAt && (input === 'r' || input === ' ' || input === '\r')) goTo('report');
    if (input === 'q' && runFinishedAt) goTo('report');
    if (input === 'q' && !runFinishedAt) goTo('report'); // soft-stop → jump to report
  });

  const includedTasks = tasks.filter((t) => t.included);
  const modelSlugs = Array.from(selectedModels);
  const totalCells = modelSlugs.length * includedTasks.length;
  const doneCells = modelSlugs.reduce((acc, s) => acc + includedTasks.filter((t) => cells[s]?.[t.id]?.state === 'passed' || cells[s]?.[t.id]?.state === 'failed' || cells[s]?.[t.id]?.state === 'error').length, 0);

  const elapsedSec = runStartedAt ? (Date.now() - runStartedAt) / 1000 : 0;
  const etaSec = doneCells > 0 && !runFinishedAt ? (elapsedSec / doneCells) * (totalCells - doneCells) : 0;

  const currentWork = (() => {
    for (const slug of modelSlugs) {
      const t = includedTasks.find((x) => cells[slug]?.[x.id]?.state === 'running');
      if (t) return `${ALL_MODELS.find((m) => m.slug === slug)?.displayName} on ${t.id}`;
    }
    return null;
  })();

  return (
    <Frame
      title="my-agent-repo · Running"
      accent={runFinishedAt ? SCREEN_ACCENT.report : SCREEN_ACCENT.liveProgress}
      subtitle={`${doneCells}/${totalCells} done · $${totalSpend.toFixed(2)} spent · elapsed ${fmtDuration(elapsedSec)}${!runFinishedAt && etaSec ? ` · eta ${fmtDuration(etaSec)}` : ''}${runFinishedAt ? ' · DONE' : ''}`}
      footer={
        runFinishedAt ? (
          <Text color="#22c55e" bold>Run complete. <Text color="cyan">enter</Text> → report</Text>
        ) : (
          <Text color="gray"><Text color="cyan">q</Text> soft-stop (finish in-flight, write partial report)</Text>
        )
      }
    >
      <Box>
        <Box width={24}><Text color="gray" bold> </Text></Box>
        {includedTasks.map((t) => (
          <Box key={t.id} width={4}><Text color="gray">{t.id}</Text></Box>
        ))}
        <Box paddingLeft={2}>
          <Box width={7}><Text color="gray" bold>pass</Text></Box>
          <Box width={9}><Text color="gray" bold>spend</Text></Box>
          <Box width={7}><Text color="gray" bold>eta</Text></Box>
        </Box>
      </Box>

      {modelSlugs.map((slug) => {
        const model = ALL_MODELS.find((m) => m.slug === slug)!;
        const modelCells = cells[slug] ?? {};
        const passed = includedTasks.filter((t) => modelCells[t.id]?.state === 'passed').length;
        const attempted = includedTasks.filter((t) => ['passed', 'failed', 'error'].includes(modelCells[t.id]?.state ?? '')).length;
        const spend = includedTasks.reduce((a, t) => a + (modelCells[t.id]?.costUsd ?? 0), 0);
        const running = includedTasks.some((t) => modelCells[t.id]?.state === 'running');
        const queued = includedTasks.filter((t) => modelCells[t.id]?.state === 'queued').length;
        const etaModel = running ? P50_RUN_SECONDS * (queued + 1) : queued * P50_RUN_SECONDS;
        return (
          <Box key={slug}>
            <Box width={24}>
              <Text color={familyColor(model.family)} bold>● </Text>
              <Text color={familyColor(model.family)}>{truncate(model.displayName, 20)}</Text>
            </Box>
            {includedTasks.map((t) => {
              const cell = modelCells[t.id];
              const state = cell?.state ?? 'queued';
              return (
                <Box key={t.id} width={4}>
                  <Text color={CELL_COLOR[state]}>{CELL_GLYPH[state]} </Text>
                </Box>
              );
            })}
            <Box paddingLeft={2}>
              <Box width={7}><Text color="white">{passed}/{attempted}</Text></Box>
              <Box width={9}><Text color="gray">${spend.toFixed(2)}</Text></Box>
              <Box width={7}><Text color="gray">{etaModel > 0 && !runFinishedAt ? `~${fmtDuration(etaModel)}` : ''}</Text></Box>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color="gray">Legend: </Text>
        <Text color={CELL_COLOR.queued}>{CELL_GLYPH.queued} </Text><Text color="gray">queued  </Text>
        <Text color={CELL_COLOR.running}>{CELL_GLYPH.running} </Text><Text color="gray">running  </Text>
        <Text color={CELL_COLOR.passed}>{CELL_GLYPH.passed} </Text><Text color="gray">pass  </Text>
        <Text color={CELL_COLOR.failed}>{CELL_GLYPH.failed} </Text><Text color="gray">fail  </Text>
        <Text color={CELL_COLOR.error}>{CELL_GLYPH.error} </Text><Text color="gray">infra-error</Text>
      </Box>

      {currentWork && (
        <Box marginTop={1}>
          <Text color="gray" dimColor>Current: <Text color="white">{currentWork}</Text></Text>
        </Box>
      )}
    </Frame>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}
function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}
