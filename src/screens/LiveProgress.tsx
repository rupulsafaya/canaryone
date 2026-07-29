import React, { useEffect, useState } from 'react';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Box, Text, useInput } from 'ink';
import { useStore, parseLane } from '../state/store.js';
import { ALL_MODELS, getDestinations, P50_RUN_SECONDS } from '../data/fixtures.js';
import { SCREEN_ACCENT, familyColor, CELL_COLOR, CELL_GLYPH } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import type { OrCatalog, OrEndpoint } from '../data/schema.js';
import { fmtDollars, fmtDuration } from '../lib/fmt.js';

function openInFileManager(dir: string): void {
  // macOS: `open`; Linux: `xdg-open`; Windows: `explorer`. spawn is fire-and-forget.
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* silent — the artifact paths are printed onscreen too */ }
}

// Resolve model + destination display metadata from wherever we can find it —
// the fixture catalog is only a mock. Real user runs select models from the
// live OR catalog; those are NOT in fixtures.ts.
function resolveLaneDisplay(
  modelSlug: string,
  destSlug: string,
  orCatalog: OrCatalog | null,
): { family: string; modelName: string; destName: string; router: string } {
  // Model family + name
  const fixtureModel = ALL_MODELS.find((m) => m.slug === modelSlug);
  const catalogModel = orCatalog?.models.find((m) => m.slug === modelSlug);
  const family = fixtureModel?.family ?? catalogModel?.family ?? familyFromSlug(modelSlug);
  const modelName = fixtureModel?.displayName ?? catalogModel?.displayName ?? modelSlug;

  // Destination name + router — try fixtures first, then OR endpoints, then slug.
  const [router = 'openrouter', ...providerParts] = destSlug.split(':');
  const providerTag = providerParts.join(':');
  const fixtureDest = getDestinations(modelSlug).find((d) => d.slug === destSlug);
  const orEndpoint: OrEndpoint | undefined = orCatalog?.endpointsBySlug?.[modelSlug]?.endpoints
    .find((e) => e.providerTag === providerTag);
  const destName = fixtureDest?.displayName ?? orEndpoint?.displayName ?? (providerTag || destSlug);

  return { family, modelName, destName, router };
}

// Column widths — chosen to fit up to ~5 tasks side by side in a 140-col frame.
// Model + destination widened; a new $/pass column made room for by tightening
// spend column formatting (now scientific-friendly, e.g. $0.000059).
const COLS = {
  model:    30,
  dest:     22,
  router:   5,
  taskCell: 4,
  pass:     8,
  spend:    11,
  costPer:  11,
  eta:      8,
};
const TOTAL_WIDTH = (nTasks: number) =>
  COLS.model + COLS.dest + COLS.router + nTasks * COLS.taskCell +
  2 + COLS.pass + COLS.spend + COLS.costPer + COLS.eta;

function familyFromSlug(slug: string): string {
  const prefix = slug.split('/')[0]?.toLowerCase() ?? 'other';
  const known = ['anthropic', 'openai', 'deepseek', 'google', 'xai', 'meta', 'qwen', 'mistral', 'cohere', 'z-ai'];
  return known.includes(prefix) ? prefix : 'other';
}

export function LiveProgress() {
  const tasks = useStore((s) => s.tasks);
  const cells = useStore((s) => s.cells);
  const runStartedAt = useStore((s) => s.runStartedAt);
  const runFinishedAt = useStore((s) => s.runFinishedAt);
  const totalSpend = useStore((s) => s.totalSpend);
  const reportPath = useStore((s) => s.reportPath);
  const runError = useStore((s) => s.runError);
  const abortRun = useStore((s) => s.abortRun);
  const reset = useStore((s) => s.reset);
  const goTo = useStore((s) => s.goTo);
  const orCatalog = useStore((s) => s.orCatalog);
  const configDir = useStore((s) => s.configDir);
  const runId = useStore((s) => s.runId);
  const totalInputTokens = useStore((s) => s.totalInputTokens);
  const totalOutputTokens = useStore((s) => s.totalOutputTokens);

  const runDir = runId ? path.join(configDir, 'runs', runId) : null;

  // Force a re-render every second so elapsed/eta refresh even while the bus
  // is idle between session transitions.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (runFinishedAt) return;
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [runFinishedAt]);

  useInput((input, key) => {
    if (!runFinishedAt) {
      // In-run: `x` aborts (finish in-flight, no new spawns).
      if (input === 'x') abortRun();
      if (input === 'q' || key.escape) { abortRun(); }
      return;
    }
    // Post-run: `o` (or Enter) opens the run dir in the OS file manager.
    if ((input === 'o' || key.return) && runDir) {
      openInFileManager(runDir);
      return;
    }
    if (input === 'r') { reset(); goTo('pickTasks'); return; }
    if (input === 'q' || key.escape) process.exit(0);
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
      subtitle={`${doneCells}/${totalCells} · ${fmtDollars(totalSpend)} · ${totalInputTokens}/${totalOutputTokens} tok · elapsed ${fmtDuration(elapsedSec)}${!runFinishedAt && etaSec ? ` · eta ${fmtDuration(etaSec)}` : ''}`}
      footer={
        runFinishedAt ? (
          <Text color="gray">
            <Text color="#22c55e" bold>DONE</Text> · <Text color="cyan">o</Text>/<Text color="cyan">enter</Text> open run dir · <Text color="cyan">r</Text> run again · <Text color="cyan">q</Text> quit
          </Text>
        ) : (
          <Text color="gray"><Text color="cyan">x</Text> abort · <Text color="cyan">q</Text> soft-stop</Text>
        )
      }
    >
      {/* Header row */}
      <Box flexShrink={0}>
        <Box width={COLS.model}><Text color="magenta" bold>Model</Text></Box>
        <Box width={COLS.dest}><Text color="magenta" bold>Destination</Text></Box>
        <Box width={COLS.router}><Text color="magenta" bold>Rtr</Text></Box>
        {includedTasks.map((t) => (
          <Box key={t.id} width={COLS.taskCell}><Text color="gray" bold>{t.id}</Text></Box>
        ))}
        <Box paddingLeft={2}>
          <Box width={COLS.pass}><Text color="magenta" bold>pass</Text></Box>
          <Box width={COLS.spend}><Text color="magenta" bold>spend</Text></Box>
          <Box width={COLS.costPer}><Text color="magenta" bold>$/pass</Text></Box>
          <Box width={COLS.eta}><Text color="magenta" bold>eta</Text></Box>
        </Box>
      </Box>
      <Box flexShrink={0}><Text color="gray" dimColor>{'─'.repeat(TOTAL_WIDTH(includedTasks.length))}</Text></Box>

      {laneKeys.map((lane) => {
        const { model: modelSlug, dest: destSlug } = parseLane(lane);
        const disp = resolveLaneDisplay(modelSlug, destSlug, orCatalog);
        const laneCells = cells[lane] ?? {};
        const passed = includedTasks.reduce((a, t) => a + (laneCells[t.id]?.passed ?? 0), 0);
        const attempted = includedTasks.reduce((a, t) => a + (laneCells[t.id]?.attempted ?? 0), 0);
        const spend = includedTasks.reduce((a, t) => a + (laneCells[t.id]?.costUsd ?? 0), 0);
        const running = includedTasks.some((t) => laneCells[t.id]?.state === 'running');
        const queued = includedTasks.filter((t) => laneCells[t.id]?.state === 'queued').length;
        const etaLane = running ? P50_RUN_SECONDS * (queued + 1) : queued * P50_RUN_SECONDS;
        return (
          <Box key={lane} flexShrink={0}>
            <Box width={COLS.model}>
              <Text color={familyColor(disp.family)} bold>● </Text>
              <Text color={familyColor(disp.family)}>{truncate(disp.modelName, COLS.model - 3)}</Text>
            </Box>
            <Box width={COLS.dest}>
              <Text color="magenta">{truncate(disp.destName, COLS.dest - 1)}</Text>
            </Box>
            <Box width={COLS.router}>
              <Text color={routerTagColor(disp.router)}>{shortRouter(disp.router)}</Text>
            </Box>
            {includedTasks.map((t) => {
              const cell = laneCells[t.id];
              const state = cell?.state ?? 'queued';
              return (
                <Box key={t.id} width={COLS.taskCell}>
                  <Text color={CELL_COLOR[state]}>{CELL_GLYPH[state]} </Text>
                </Box>
              );
            })}
            <Box paddingLeft={2}>
              <Box width={COLS.pass}><Text color="white">{passed}/{attempted}</Text></Box>
              <Box width={COLS.spend}><Text color="gray">{fmtDollars(spend)}</Text></Box>
              <Box width={COLS.costPer}>
                <Text color={passed > 0 ? '#22c55e' : 'gray'}>
                  {passed > 0 ? fmtDollars(spend / passed) : '—'}
                </Text>
              </Box>
              <Box width={COLS.eta}><Text color="gray">{etaLane > 0 && !runFinishedAt ? `~${fmtDuration(etaLane)}` : ''}</Text></Box>
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

      {runFinishedAt && runDir && (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text color="#22c55e" bold>Run complete.</Text>
          <Box marginTop={0}>
            <Text color="gray">Run dir: </Text>
            <Text color="cyan" bold>{runDir}</Text>
          </Box>
          <Box marginTop={0}>
            <Text color="gray" dimColor>  traffic.jsonl · sessions/&lt;session_id&gt;.md · meta.json</Text>
          </Box>
          <Box>
            <Text color="gray">SQLite: </Text>
            <Text color="cyan">{path.join(configDir, 'db.sqlite')}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Press </Text>
            <Text color="cyan" bold>o</Text>
            <Text color="gray"> or </Text>
            <Text color="cyan" bold>enter</Text>
            <Text color="gray"> to open the run dir in Finder.</Text>
          </Box>
        </Box>
      )}

      {runError && (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text color="#ef4444" bold>Run error:</Text>
          <Text color="white">{runError}</Text>
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
