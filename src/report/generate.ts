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

export async function generate(runId: string, configDir: string): Promise<string> {
  const data = await loadRun(runId, configDir);

  const [hero, inventory] = await Promise.all([
    Promise.resolve(renderHero(data)),
    renderInventory(data),
  ]);

  const stubs = renderStubs();

  const html = shell(runId, data.run.target_dir, { hero, inventory, stubs });

  const outDir = path.join(configDir, 'runs', runId, 'report');
  await fsp.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'index.html');
  await fsp.writeFile(outPath, html, 'utf8');
  return outPath;
}

// Phase-1 placeholders. Keeping the section shell (numbered h2 + explain
// details) means Bhaskar can drop real renderers in without moving the
// page around.
function renderStubs(): string {
  const specs = [
    { id: 's1', num: '01', title: 'Leaderboard' },
    { id: 's2', num: '02', title: 'Lane table (sortable)' },
    { id: 's3', num: '03', title: 'Heatmap · lanes × tasks' },
    { id: 's4', num: '04', title: 'Session drilldown' },
    { id: 's5', num: '05', title: 'Aggregate stats' },
  ];
  return specs.map((s) => `
<section id="${s.id}" class="stub">
  <h2><span class="sec-num">${s.num}</span>${s.title}</h2>
  <div class="todo">Phase 1 — not yet implemented. See <code>c1-report-29july-SPEC.md</code> §7 for the wireframe.</div>
</section>`).join('');
}
