// Report generator entry point.
// Called by the orchestrator after judgePool.drain(), and by the future
// `c1 runs report <runId>` CLI subcommand.
//
// Returns the absolute path to the written HTML.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { loadRun } from './data.js';
import { shell } from './template.js';
import { renderHero } from './sections/hero.js';
import { renderInventory } from './sections/inventory.js';
import { renderLeaderboard } from './sections/leaderboard.js';
import { renderLaneTable } from './sections/lane-table.js';
import { renderHeatmap } from './sections/heatmap.js';
import { renderSessionList } from './sections/session-list.js';
import { renderAggregate } from './sections/aggregate.js';
import { renderTweetCard } from './sections/tweet-card.js';
import { renderNextReport } from './next-report.js';

export async function generate(runId: string, configDir: string): Promise<string> {
  const data = await loadRun(runId, configDir);

  const [hero, inventory, leaderboard, laneTable, heatmap, sessionList, aggregate] = await Promise.all([
    Promise.resolve(renderHero(data)),
    renderInventory(data),
    Promise.resolve(renderLeaderboard(data)),
    Promise.resolve(renderLaneTable(data)),
    Promise.resolve(renderHeatmap(data)),
    Promise.resolve(renderSessionList(data)),
    Promise.resolve(renderAggregate(data)),
  ]);

  const report = [leaderboard, laneTable, heatmap, sessionList, aggregate].join('\n');

  const html = shell(runId, data.run.target_dir, { hero, report, inventory });
  const tweetHtml = renderTweetCard(data);

  const outDir = path.join(configDir, 'runs', runId, 'report');
  await fsp.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'index.html');
  await fsp.writeFile(outPath, html, 'utf8');
  // Screenshot-first sibling artifact — fixed-width hero with lane bars +
  // 3 findings. Independent document (own <html>), so it screenshots cleanly.
  await fsp.writeFile(path.join(outDir, 'tweet.html'), tweetHtml, 'utf8');
  // Next-generation report — canaryone-brand aesthetic (cream + canary),
  // starting with the Pareto section. Will gradually absorb sections from
  // index.html as they get rethemed. Standalone HTML, own <html>.
  const nextHtml = renderNextReport(data);
  await fsp.writeFile(path.join(outDir, 'report.html'), nextHtml, 'utf8');
  return outPath;
}
