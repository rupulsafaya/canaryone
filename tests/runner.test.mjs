// D2/M1 integration test: exercise the RunEngine end-to-end against the
// openai-sdk-echo fixture. Faster + cheaper than driving the full TUI.
//
// Asserts:
//   - session reaches terminal state (passed or failed)
//   - .c1/runs/<runId>/traffic.jsonl has at least one request + response record
//   - .c1/db.sqlite has 1 row each in runs / sessions / steps
//   - .c1/runs/<runId>/sessions/<sessionId>.md exists
//
// Cost: ~$0.001 per run (one OR chat completion via a cheap model).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

async function tsxImport(rel) {
  // Use tsx --eval to import a TS module via a small shim? Simpler: use dynamic import
  // with ts-node/tsx's ESM loader. Since this test file runs under node (not tsx),
  // we need to shell out to tsx. Do it below via spawn.
  return rel; // placeholder — we'll invoke via tsx harness.
}

// Because RunEngine lives in TypeScript, run this test via tsx: `tsx tests/runner.test.mjs`.
// For the ESM+TS interop shim, we import from a tsx runtime that already resolved:

async function main() {
  const canaryoneDir = new URL('..', import.meta.url).pathname;
  const fixtureDir = path.join(canaryoneDir, 'tests/fixtures/openai-sdk-echo');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-runner-'));
  const configDir = path.join(scratch, '.c1');
  await fs.mkdir(configDir, { recursive: true });

  // Load the OR key from ~/.c1/.env (real runs need it).
  const homeEnv = path.join(os.homedir(), '.c1/.env');
  const envRaw = await fs.readFile(homeEnv, 'utf8').catch(() => '');
  const keyMatch = envRaw.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+?)\s*$/m);
  const orKey = keyMatch ? keyMatch[1].replace(/^["']|["']$/g, '').trim() : null;
  if (!orKey) {
    console.error('SKIP: ~/.c1/.env missing OPENROUTER_API_KEY — runner integration cannot proceed.');
    process.exit(2);
  }

  // Dynamic import of RunEngine via the local tsx loader.
  const { RunEngine } = await import(pathToFileURL(path.join(canaryoneDir, 'src/runner/orchestrator.ts')).href);

  const runId = randomUUID();
  const spec = {
    runId,
    targetDir: fixtureDir,
    configDir,
    parallelism: 1,
    repeats: 1,
    maxSpend: 1.0,
    lanes: [{
      // Non-reasoning cheap chat model — reliably returns text for short
      // prompts (reasoning models can burn max_tokens on internal cot and
      // leave content empty).
      modelSlug: 'openai/gpt-oss-20b',
      destinationSlug: 'openrouter:openai',
      router: 'openrouter',
      providerTag: null,          // OR picks default provider
      endpoint: null,             // no per-provider endpoint hydration
      // Exercise the fallback pricing path (mirrors what happens when the
      // picker's providerTag doesn't match any endpoint from /endpoints).
      fallbackModelPrice: { input: 0.05, output: 0.20 },
    }],
    tasks: [{ id: 't01', file: 'test/agent.test.js' }],
    orKey,
    runnerCmd: 'npm test',        // resolved via package.json:scripts at spawn
    sessionTimeoutMs: 60_000,
  };

  console.log('[integration] runId =', runId);
  console.log('[integration] scratch =', scratch);
  console.log('[integration] target =', fixtureDir);

  const engine = new RunEngine();
  const events = [];
  for (const e of ['run:started', 'session:running', 'session:complete', 'session:failed', 'run:complete']) {
    engine.bus.on(e, (payload) => events.push({ e, payload }));
  }

  const result = await engine.run(spec);
  console.log('[integration] result:', {
    passed: result.passed, failed: result.failed, aborted: result.aborted,
    totalCostUsd: result.totalCostUsd, sessions: result.totalSessions,
  });

  // ---------- assertions ----------

  const runDir = path.join(configDir, 'runs', runId);
  const jsonlPath = path.join(runDir, 'traffic.jsonl');
  const dbPath = path.join(configDir, 'db.sqlite');

  const jsonlContent = await fs.readFile(jsonlPath, 'utf8');
  const lines = jsonlContent.split('\n').filter((l) => l.trim());
  const parsed = lines.map((l) => JSON.parse(l));
  const requests = parsed.filter((r) => r.kind === 'request');
  const responses = parsed.filter((r) => r.kind === 'response');
  console.log('[integration] jsonl lines:', lines.length,
    '| requests:', requests.length, '| responses:', responses.length);

  if (requests.length < 1) throw new Error('expected >= 1 request in traffic.jsonl');
  if (responses.length < 1) throw new Error('expected >= 1 response in traffic.jsonl');

  // SQLite content
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const runCount = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE id = ?').get(runId).n;
  const sessCount = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE run_id = ?').get(runId).n;
  const stepCount = db.prepare(`
    SELECT COUNT(*) AS n FROM steps s
    JOIN sessions ss ON s.session_id = ss.id
    WHERE ss.run_id = ?
  `).get(runId).n;
  console.log('[integration] sqlite: runs=', runCount, 'sessions=', sessCount, 'steps=', stepCount);
  db.close();

  if (runCount !== 1) throw new Error(`expected 1 run row, got ${runCount}`);
  if (sessCount !== 1) throw new Error(`expected 1 session row, got ${sessCount}`);
  if (stepCount < 1) throw new Error(`expected >= 1 step row, got ${stepCount}`);

  // Session MD exists
  const sessionsDir = path.join(runDir, 'sessions');
  const sessionFiles = await fs.readdir(sessionsDir);
  if (sessionFiles.length !== 1) throw new Error(`expected 1 session md, got ${sessionFiles.length}`);
  const mdPath = path.join(sessionsDir, sessionFiles[0]);
  const md = await fs.readFile(mdPath, 'utf8');
  if (!/# Session /.test(md)) throw new Error('session md missing header');
  if (!/Verdict/.test(md)) throw new Error('session md missing verdict line');
  console.log('[integration] session md:', mdPath, '(' + md.length + ' bytes)');

  console.log('[integration] PASS · cost $' + result.totalCostUsd.toFixed(6));
  console.log('[integration] scratch preserved at', scratch, '— rm it to reclaim');
}

main().catch((e) => {
  console.error('[integration] FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
