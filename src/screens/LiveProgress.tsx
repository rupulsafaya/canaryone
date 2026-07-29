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

function openInFileManager(target: string): void {
  // macOS: `open`; Linux: `xdg-open`; Windows: `explorer`. spawn is fire-and-forget.
  // Also handles opening HTML files in the default browser — `open` on macOS
  // routes .html to the default browser automatically.
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
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
  // Widened to fit "12t·34s ⠧" (activity string) — was 8, now 10.
  eta:      10,
};
const TOTAL_WIDTH = (nTasks: number) =>
  COLS.model + COLS.dest + COLS.router + nTasks * COLS.taskCell +
  2 + COLS.pass + COLS.spend + COLS.costPer + COLS.eta;

function familyFromSlug(slug: string): string {
  const prefix = slug.split('/')[0]?.toLowerCase() ?? 'other';
  const known = ['anthropic', 'openai', 'deepseek', 'google', 'xai', 'meta', 'qwen', 'mistral', 'cohere', 'z-ai'];
  return known.includes(prefix) ? prefix : 'other';
}

// Braille spinner frames — cycles every 100ms while any activity is in flight
// (sessions running OR judge draining OR report generating). Cheap eye-anchor
// so the user never sees a still screen and assumes it's stuck.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function LiveProgress() {
  const tasks = useStore((s) => s.tasks);
  const cells = useStore((s) => s.cells);
  const runStartedAt = useStore((s) => s.runStartedAt);
  const sessionsCompleteAt = useStore((s) => s.sessionsCompleteAt);
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
  const totalSessions = useStore((s) => s.totalSessions);
  const judgedCount = useStore((s) => s.judgedCount);
  const totalInputTokens = useStore((s) => s.totalInputTokens);
  const totalOutputTokens = useStore((s) => s.totalOutputTokens);
  const reportHtmlPath = useStore((s) => s.reportHtmlPath);
  const reportGenerating = useStore((s) => s.reportGenerating);
  const reportError = useStore((s) => s.reportError);

  const runDir = runId ? path.join(configDir, 'runs', runId) : null;

  // Two ticks: a fast one (100ms) drives the spinner + activity strings during
  // any active phase; a slow one (1s) is enough to refresh elapsed/eta once
  // everything is done and just showing final state.
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const activePhase = !runFinishedAt;
  useEffect(() => {
    if (!activePhase) return;
    const t = setInterval(() => setSpinnerIdx((i) => (i + 1) % SPINNER_FRAMES.length), 100);
    return () => clearInterval(t);
  }, [activePhase]);
  const spinner = SPINNER_FRAMES[spinnerIdx];

  useInput((input, key) => {
    if (!runFinishedAt) {
      // In-run: `x` aborts (finish in-flight, no new spawns).
      if (input === 'x') abortRun();
      if (input === 'q' || key.escape) { abortRun(); }
      return;
    }
    // Post-run:
    //   enter / v → open the HTML report in the default browser (money-shot)
    //   o         → open the run dir in the file manager
    //   r         → run again
    //   q / esc   → quit
    if ((key.return || input === 'v') && reportHtmlPath) {
      openInFileManager(reportHtmlPath);
      return;
    }
    if (input === 'o' && runDir) {
      openInFileManager(runDir);
      return;
    }
    if (input === 'r') { reset(); goTo('pickTasks'); return; }
    if (input === 'q' || key.escape) process.exit(0);
  });

  const includedTasks = tasks.filter((t) => t.included);
  const laneKeys = Object.keys(cells);
  const repeats = useStore((s) => s.repeats) || 1;
  const totalCells = laneKeys.length * includedTasks.length;
  const doneCells = laneKeys.reduce((acc, lane) => acc + includedTasks.filter((t) => {
    const st = cells[lane]?.[t.id]?.state;
    return st === 'passed' || st === 'failed' || st === 'error';
  }).length, 0);

  const elapsedSec = runStartedAt ? (Date.now() - runStartedAt) / 1000 : 0;
  const etaSec = doneCells > 0 && !runFinishedAt ? (elapsedSec / doneCells) * (totalCells - doneCells) : 0;

  // Phase = what's actually happening RIGHT NOW.
  //   'pre'      → sessions running (title=Running yellow)
  //   'judging'  → all sessions done, judge draining (title=Judging amber)
  //   'report'   → judge done, HTML report generating (title=Rendering blue)
  //   'done'     → everything done (title=Run complete green)
  const phase: 'pre' | 'judging' | 'report' | 'done' =
    runFinishedAt ? 'done'
      : reportGenerating ? 'report'
        : sessionsCompleteAt ? 'judging'
          : 'pre';

  const title =
    phase === 'done'    ? 'Run complete'
      : phase === 'report'  ? `Rendering report ${spinner}`
        : phase === 'judging' ? `Wrapping up · judging ${spinner}`
          : `Running ${spinner}`;
  const accent =
    phase === 'done'    ? '#22c55e'
      : phase === 'report'  ? '#3b82f6'
        : phase === 'judging' ? '#eab308'
          : SCREEN_ACCENT.liveProgress;

  const subtitle = (() => {
    const base = `${doneCells}/${totalCells} · ${fmtDollars(totalSpend)} · ${totalInputTokens}/${totalOutputTokens} tok · elapsed ${fmtDuration(elapsedSec)}`;
    if (phase === 'pre' && etaSec) return `${base} · eta ${fmtDuration(etaSec)}`;
    if (phase === 'judging') {
      const remaining = Math.max(0, totalSessions - judgedCount);
      return `${base} · judged ${judgedCount}/${totalSessions}${remaining ? ` · ${remaining} in flight` : ''}`;
    }
    if (phase === 'report') return `${base} · generating HTML report`;
    return base;
  })();

  return (
    <Frame
      title={title}
      accent={accent}
      subtitle={subtitle}
      footer={
        runFinishedAt ? (
          <Text color="gray">
            <Text color="#22c55e" bold>DONE</Text>
            {' · '}
            {reportGenerating
              ? <><Text color="#eab308">generating report…</Text></>
              : reportHtmlPath
                ? <><Text color="cyan">enter</Text>/<Text color="cyan">v</Text> view report</>
                : <Text color="gray" dimColor>report unavailable</Text>}
            {' · '}<Text color="cyan">o</Text> open run dir · <Text color="cyan">r</Text> run again · <Text color="cyan">q</Text> quit
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
        // Show passed/expected while running so the user sees "1/3" for a lane
        // with 2 repeats still in flight, not the misleading "1/1 pass" that
        // reads as "done." Post-run, expected === attempted so no change.
        const expected = includedTasks.length * repeats;
        const spend = includedTasks.reduce((a, t) => a + (laneCells[t.id]?.costUsd ?? 0), 0);
        const running = includedTasks.some((t) => laneCells[t.id]?.state === 'running');
        const queued = includedTasks.filter((t) => laneCells[t.id]?.state === 'queued').length;
        const etaLane = running ? P50_RUN_SECONDS * (queued + 1) : queued * P50_RUN_SECONDS;
        // Live-activity string for the eta column: when a session on this
        // lane is currently running, show "Nt·Xs ⠧" (turn count + elapsed
        // + spinner) instead of eta. Zero-guessing feedback that the lane
        // isn't stuck — visible from any scroll position.
        const runningCell = includedTasks
          .map((t) => laneCells[t.id])
          .find((c) => c?.state === 'running');
        const activityString: string | null = runningCell?.runningSince
          ? (() => {
              const secs = Math.max(0, (Date.now() - runningCell.runningSince) / 1000);
              const turns = runningCell.liveStepCount ?? 0;
              return `${turns}t·${Math.round(secs)}s ${spinner}`;
            })()
          : null;
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
              <Box width={COLS.pass}>
                <Text color="white">{passed}/{runFinishedAt ? attempted : expected}</Text>
              </Box>
              <Box width={COLS.spend}><Text color="gray">{fmtDollars(spend)}</Text></Box>
              <Box width={COLS.costPer}>
                <Text color={passed > 0 ? '#22c55e' : 'gray'}>
                  {passed > 0 ? fmtDollars(spend / passed) : '—'}
                </Text>
              </Box>
              <Box width={COLS.eta}>
                {activityString
                  ? <Text color="#eab308" bold>{activityString}</Text>
                  : <Text color="gray">{etaLane > 0 && !runFinishedAt ? `~${fmtDuration(etaLane)}` : ''}</Text>}
              </Box>
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
          {reportGenerating && (
            <Box marginTop={0}>
              <Text color="#eab308">⣾ generating HTML report… </Text>
              <Text color="gray" dimColor>(inspecting traffic + SQLite)</Text>
            </Box>
          )}
          {reportHtmlPath && (
            <Box marginTop={0} flexDirection="column">
              <Box>
                <Text color="gray">Report: </Text>
                <Text color="#22c55e" bold>{reportHtmlPath}</Text>
              </Box>
              <Box>
                <Text color="gray">        Press </Text>
                <Text color="cyan" bold>enter</Text>
                <Text color="gray"> or </Text>
                <Text color="cyan" bold>v</Text>
                <Text color="gray"> to view in your browser.</Text>
              </Box>
            </Box>
          )}
          {reportError && !reportGenerating && (
            <Box marginTop={0}>
              <Text color="#ef4444">Report failed: </Text>
              <Text color="gray">{reportError}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color="gray">Run dir: </Text>
            <Text color="cyan">{runDir}</Text>
            <Text color="gray" dimColor>  (press </Text>
            <Text color="cyan">o</Text>
            <Text color="gray" dimColor> to open in Finder)</Text>
          </Box>
          <Box>
            <Text color="gray" dimColor>  traffic.jsonl · sessions/&lt;session_id&gt;.md · meta.json · report/index.html</Text>
          </Box>
          <Box>
            <Text color="gray">SQLite: </Text>
            <Text color="cyan">{path.join(configDir, 'db.sqlite')}</Text>
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
