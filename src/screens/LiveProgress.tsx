import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore, parseLane } from '../state/store.js';
import { ALL_MODELS, getDestinations, P50_RUN_SECONDS } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor, CELL_COLOR, CELL_GLYPH } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

export function LiveProgress() {
  const tasks = useStore((s) => s.tasks);
  const cells = useStore((s) => s.cells);
  const runStartedAt = useStore((s) => s.runStartedAt);
  const runFinishedAt = useStore((s) => s.runFinishedAt);
  const totalSpend = useStore((s) => s.totalSpend);
  const reportPath = useStore((s) => s.reportPath);
  const tick = useStore((s) => s.tick);
  const reset = useStore((s) => s.reset);
  const goTo = useStore((s) => s.goTo);

  useEffect(() => {
    if (runFinishedAt) return;
    const timer = setInterval(tick, 300);
    return () => clearInterval(timer);
  }, [runFinishedAt, tick]);

  useInput((input, key) => {
    if (!runFinishedAt) return;
    if (input === 'q' || key.escape) process.exit(0);
    if (input === 'r') { reset(); goTo('pickTasks'); }
    if (input === 'o' || key.return) {
      // In real product: `open` shell out. Mock: no-op.
    }
  });

  const includedTasks = tasks.filter((t) => t.included);
  const laneKeys = Object.keys(cells);
  const totalCells = laneKeys.length * includedTasks.length;
  const doneCells = laneKeys.reduce((acc, lane) => acc + includedTasks.filter((t) => {
    const st = cells[lane]?.[t.id]?.state;
    return st === 'passed' || st === 'failed' || st === 'error';
  }).length, 0);

  const elapsedSec = runStartedAt ? (Date.now() - runStartedAt) / 1000 : 0;
  const etaSec = doneCells > 0 && !runFinishedAt ? (elapsedSec / doneCells) * (totalCells - doneCells) : 0;

  return (
    <Frame
      title={runFinishedAt ? 'Run complete' : 'Running'}
      accent={runFinishedAt ? '#22c55e' : SCREEN_ACCENT.liveProgress}
      subtitle={`${doneCells}/${totalCells} · $${totalSpend.toFixed(2)} · elapsed ${fmtDuration(elapsedSec)}${!runFinishedAt && etaSec ? ` · eta ${fmtDuration(etaSec)}` : ''}`}
      footer={
        runFinishedAt ? (
          <Text color="gray">
            <Text color="#22c55e" bold>DONE</Text> · <Text color="cyan">o / enter</Text> open report · <Text color="cyan">r</Text> run again · <Text color="cyan">q</Text> quit
          </Text>
        ) : (
          <Text color="gray"><Text color="cyan">q</Text> soft-stop (finish in-flight, write partial report)</Text>
        )
      }
    >
      {/* Header row */}
      <Box flexShrink={0}>
        <Box width={20}><Text color="magenta" bold>Model</Text></Box>
        <Box width={18}><Text color="magenta" bold>Destination</Text></Box>
        <Box width={6}><Text color="magenta" bold>Rtr</Text></Box>
        {includedTasks.map((t) => (
          <Box key={t.id} width={4}><Text color="gray" bold>{t.id}</Text></Box>
        ))}
        <Box paddingLeft={2}>
          <Box width={7}><Text color="magenta" bold>pass</Text></Box>
          <Box width={9}><Text color="magenta" bold>spend</Text></Box>
          <Box width={7}><Text color="magenta" bold>eta</Text></Box>
        </Box>
      </Box>
      <Box flexShrink={0}><Text color="gray" dimColor>{'─'.repeat(90)}</Text></Box>

      {laneKeys.map((lane) => {
        const { model: modelSlug, dest: destSlug } = parseLane(lane);
        const model = ALL_MODELS.find((m) => m.slug === modelSlug)!;
        const dest = getDestinations(modelSlug).find((d) => d.slug === destSlug);
        const laneCells = cells[lane] ?? {};
        const passed = includedTasks.filter((t) => laneCells[t.id]?.state === 'passed').length;
        const attempted = includedTasks.filter((t) => ['passed', 'failed', 'error'].includes(laneCells[t.id]?.state ?? '')).length;
        const spend = includedTasks.reduce((a, t) => a + (laneCells[t.id]?.costUsd ?? 0), 0);
        const running = includedTasks.some((t) => laneCells[t.id]?.state === 'running');
        const queued = includedTasks.filter((t) => laneCells[t.id]?.state === 'queued').length;
        const etaLane = running ? P50_RUN_SECONDS * (queued + 1) : queued * P50_RUN_SECONDS;
        return (
          <Box key={lane} flexShrink={0}>
            <Box width={20}>
              <Text color={familyColor(model.family)} bold>● </Text>
              <Text color={familyColor(model.family)}>{truncate(model.displayName, 17)}</Text>
            </Box>
            <Box width={18}>
              <Text color="magenta">{truncate(dest?.displayName ?? destSlug, 17)}</Text>
            </Box>
            <Box width={6}>
              <Text color={routerTagColor(dest?.router)}>{shortRouter(dest?.router)}</Text>
            </Box>
            {includedTasks.map((t) => {
              const cell = laneCells[t.id];
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
              <Box width={7}><Text color="gray">{etaLane > 0 && !runFinishedAt ? `~${fmtDuration(etaLane)}` : ''}</Text></Box>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} flexShrink={0}>
        <Text color="gray" dimColor>legend: </Text>
        <Text color={CELL_COLOR.queued}>{CELL_GLYPH.queued} </Text><Text color="gray">queued </Text>
        <Text color={CELL_COLOR.running}>{CELL_GLYPH.running} </Text><Text color="gray">running </Text>
        <Text color={CELL_COLOR.passed}>{CELL_GLYPH.passed} </Text><Text color="gray">pass </Text>
        <Text color={CELL_COLOR.failed}>{CELL_GLYPH.failed} </Text><Text color="gray">fail </Text>
        <Text color={CELL_COLOR.error}>{CELL_GLYPH.error} </Text><Text color="gray">infra-error</Text>
      </Box>

      {runFinishedAt && reportPath && (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text color="#22c55e" bold>Run complete.</Text>
          <Box marginTop={0}>
            <Text color="gray">Rich HTML report saved to:</Text>
          </Box>
          <Box>
            <Text color="cyan" bold>  {reportPath}</Text>
          </Box>
        </Box>
      )}
    </Frame>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}
function shortRouter(r: string | undefined) {
  return r === 'openrouter' ? 'OR' : r === 'direct' ? 'dir' : r === 'bedrock' ? 'bed' : r === 'vertex' ? 'ver' : r === 'azure' ? 'azr' : 'OR';
}
function routerTagColor(r: string | undefined) {
  return r === 'direct' ? '#a78bfa' : r === 'bedrock' ? '#f97316' : r === 'vertex' ? '#4ade80' : r === 'azure' ? '#60a5fa' : '#22d3ee';
}
function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}
