// Runs ONE real judge.test.cjs fixture through the proxy.
// Reuses job-search-automation's lib/judge.cjs verbatim — proves the real workload path.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/Users/rupulsafaya/Documents/GitHub/job-search-automation/');
const Anthropic = require('@anthropic-ai/sdk');
const { judgeJob } = require('/Users/rupulsafaya/Documents/GitHub/job-search-automation/lib/judge.cjs');

const REPO = '/Users/rupulsafaya/Documents/GitHub/job-search-automation';
const fixtures = fs.readdirSync(path.join(REPO, 'test/fixtures/judge')).filter(f => f.endsWith('.json')).sort();
console.log(`found ${fixtures.length} fixtures. Running #1: ${fixtures[0]}`);

const fx = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/judge', fixtures[0]), 'utf8'));
const criteria = JSON.parse(fs.readFileSync(path.join(REPO, 'config/criteria.json'), 'utf8'));

const claude = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY ?? 'sk-fake',
});

console.log(`baseURL resolved to: ${claude.baseURL}`);
console.log(`\ninput: fixture ${fixtures[0]}`);
console.log(`expected: pass=${fx.expected?.llm_pass}  score in [${fx.expected?.llm_score_min}..${fx.expected?.llm_score_max}]`);

const t0 = Date.now();
try {
  const verdict = await judgeJob({ job: fx.job, claude, criteria });
  const ms = Date.now() - t0;
  console.log(`\n--- VERDICT (${ms}ms) ---`);
  console.log(JSON.stringify(verdict, null, 2).slice(0, 1500));
  const match = verdict.llm_pass === fx.expected?.llm_pass;
  console.log(`\nverdict matches expected? ${match}  (deepseek vs. claude — some divergence expected; wire success is the goal)`);
} catch (e) {
  console.error(`FAILED (${Date.now() - t0}ms):`, e);
  process.exit(2);
}
