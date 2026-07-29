#!/usr/bin/env node
// Backfill cost_usd on steps + sessions for a specific run when the original
// LaneSpec was missing pricing (typical: direct providers that don't expose
// pricing through their API and weren't yet hand-seeded in DIRECT_PRICING).
//
// Usage:
//   node scripts/backfill-cost.mjs <sqlite-path> <runId> [--dry-run]
//
// Reads token counts + destination from the existing rows, joins against the
// canaryone src/proxy/providers.ts DIRECT_PRICING table (imported live from
// the checkout), recomputes cost, writes back. Non-destructive without
// --dry-run flag removal: prints a per-lane diff before touching rows.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  const [, , dbPath, runId, ...flags] = process.argv;
  if (!dbPath || !runId) {
    console.error('usage: backfill-cost.mjs <sqlite-path> <runId> [--dry-run]');
    process.exit(1);
  }
  const dryRun = flags.includes('--dry-run');

  const canaryoneDir = new URL('..', import.meta.url).pathname;
  const providersUrl = pathToFileURL(path.join(canaryoneDir, 'src/proxy/providers.ts')).href;
  const routeIndexUrl = pathToFileURL(path.join(canaryoneDir, 'src/data/route-index.ts')).href;
  const { DIRECT_PRICING } = await import(providersUrl);
  // Reuse the same wire-slug → canonical price key logic PickRoutes uses.
  // route-index doesn't export tryDirectPriceKey; duplicate the tiny match
  // inline to keep this script self-contained.
  const priceKeyFor = (dest, wire) => {
    const s = wire.toLowerCase();
    const isFast = /(-|\.)fast\b|k3p_?fast|kimi-k3-fast|glm-5p2-fast|5\.2-fast/.test(s);
    if (s.includes('kimi') && (s.includes('k3') || s.includes('k3p') || s.includes('k3-'))) {
      return isFast ? 'moonshotai/kimi-k3-fast' : 'moonshotai/kimi-k3';
    }
    if (s.includes('glm') && (s.includes('5.2') || s.includes('5p2'))) {
      return isFast ? 'z-ai/glm-5.2-fast' : 'z-ai/glm-5.2';
    }
    return null;
  };

  const db = new DatabaseSync(dbPath, { readOnly: false });
  const sessionRows = db.prepare(
    'SELECT id, model_slug, destination_slug, cost_usd FROM sessions WHERE run_id = ?',
  ).all(runId);
  if (sessionRows.length === 0) {
    console.error(`no sessions found for run ${runId}`);
    process.exit(2);
  }

  let touchedSessions = 0;
  let touchedSteps = 0;
  const laneRoll = new Map();

  for (const sess of sessionRows) {
    const dest = String(sess.destination_slug);
    const wire = String(sess.model_slug);
    if (!dest.startsWith('direct:') && !dest.startsWith('vercel')) continue;
    const priceTable = DIRECT_PRICING[dest];
    if (!priceTable) continue;
    const key = priceKeyFor(dest, wire);
    const price = key ? priceTable[key] : null;
    if (!price) continue;

    // Recompute cost per step from tokens.
    const steps = db.prepare(
      'SELECT id, input_tokens, output_tokens, cost_usd FROM steps WHERE session_id = ?',
    ).all(sess.id);
    let sessionNewCost = 0;
    for (const step of steps) {
      const newCost = (Number(step.input_tokens) / 1e6) * price.input
                    + (Number(step.output_tokens) / 1e6) * price.output;
      sessionNewCost += newCost;
      if (!dryRun && Math.abs(Number(step.cost_usd) - newCost) > 1e-9) {
        db.prepare('UPDATE steps SET cost_usd = ? WHERE id = ?').run(newCost, step.id);
        touchedSteps++;
      }
    }
    if (!dryRun && Math.abs(Number(sess.cost_usd) - sessionNewCost) > 1e-9) {
      db.prepare('UPDATE sessions SET cost_usd = ? WHERE id = ?').run(sessionNewCost, sess.id);
      touchedSessions++;
    }
    const laneKey = `${wire}@${dest}`;
    const roll = laneRoll.get(laneKey) ?? { was: 0, now: 0, sessions: 0 };
    roll.was += Number(sess.cost_usd);
    roll.now += sessionNewCost;
    roll.sessions++;
    laneRoll.set(laneKey, roll);
  }

  console.log(`\nbackfill${dryRun ? ' (dry run)' : ''} — run ${runId}\n`);
  console.log('lane                                                     sessions   was       now       delta');
  console.log('─'.repeat(100));
  for (const [lane, roll] of laneRoll) {
    console.log(
      lane.slice(0, 54).padEnd(56) +
      String(roll.sessions).padStart(4) + '      ' +
      `$${roll.was.toFixed(4)}`.padStart(9) + '  ' +
      `$${roll.now.toFixed(4)}`.padStart(9) + '  ' +
      `+$${(roll.now - roll.was).toFixed(4)}`,
    );
  }
  console.log();
  console.log(dryRun
    ? `dry run — no rows touched. Drop --dry-run to persist.`
    : `wrote ${touchedSteps} steps + ${touchedSessions} sessions`);
  console.log(`then: c1 runs report ${runId}   (regenerates the HTML from the updated rows)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
