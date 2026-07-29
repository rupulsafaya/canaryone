import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnTui, runTests } from './tui-harness.mjs';

const TARGET_REAL = path.join(os.homedir(), 'Documents/GitHub/job-search-automation');
const HOME_ENV = path.join(os.homedir(), '.c1/.env');
const FIXTURES_DIR = new URL('./fixtures/', import.meta.url).pathname;

async function withScratchDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-test-'));
  try { await fn(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function backupHomeEnv() {
  try {
    const raw = await fs.readFile(HOME_ENV, 'utf8');
    await fs.rename(HOME_ENV, HOME_ENV + '.bak-test');
    return raw;
  } catch {
    return null;
  }
}

async function restoreHomeEnv(hadBackup) {
  try { await fs.unlink(HOME_ENV); } catch {}
  if (hadBackup != null) {
    try { await fs.rename(HOME_ENV + '.bak-test', HOME_ENV); } catch {}
  }
}

const tests = [];

// --- Scenario A: fresh boot, no key anywhere ---
tests.push(['A. Fresh KeySetup: prompt → char-by-char → invalid → retry → paste → Esc quit', async () => {
  const hadBackup = await backupHomeEnv();
  try {
    await withScratchDir(async (scratchDir) => {
      // Pinned to --start keySetup: default boot is now ApiKeys (A4.5).
      // Full A6 rewrites A/B against ApiKeys and deletes this screen.
      const t = spawnTui(['--start', 'keySetup', '--config-dir', scratchDir, '--target', TARGET_REAL]);
      try {
        await t.waitFor('paste your OpenRouter', 10000);
        t.send('sk-or-v1-bogus-testing-1234567890abcdef');
        await t.waitFor('(39 chars)', 3000);
        t.sendKey('enter');
        await t.waitFor('OpenRouter did not accept', 8000);
        t.send('r');
        await t.waitFor('paste your OpenRouter', 3000);
        await t.sleep(200);                                       // let mode settle
        t.reset();
        t.send('sk-or-v1-bulk-paste-test-abcdefghijklmnopqr');   // 43 chars
        await t.waitFor('(43 chars)', 5000);
        t.sendKey('enter');
        await t.waitFor('OpenRouter did not accept', 8000);
        // Esc from invalid intentionally exits 1 (user gave up on bad key).
        t.sendKey('esc');
        await t.waitExit(3000);
        if (t.exitCode() !== 1) throw new Error(`expected exit 1 from invalid-Esc, got ${t.exitCode()}`);
      } finally {
        t.kill();
      }
    });
  } finally {
    await restoreHomeEnv(hadBackup);
  }
}]);

// --- Scenario B: bogus key pre-seeded in ~/.c1/.env ---
tests.push(['B. Saved bogus key auto-validated → invalid → retry → prompt → Esc quit', async () => {
  const hadBackup = await backupHomeEnv();
  try {
    await fs.mkdir(path.dirname(HOME_ENV), { recursive: true });
    await fs.writeFile(HOME_ENV, 'OPENROUTER_API_KEY=sk-or-v1-scenario-b-bogus\n', { mode: 0o600 });
    await withScratchDir(async (scratchDir) => {
      const t = spawnTui(['--start', 'keySetup', '--config-dir', scratchDir, '--target', TARGET_REAL]);
      try {
        await t.waitFor(/looking for|calling OpenRouter|OpenRouter did not accept/, 5000);
        await t.waitFor('OpenRouter did not accept', 10000);
        t.send('r');
        await t.waitFor('paste your OpenRouter', 3000);
        t.sendKey('esc');
        await t.waitExit(3000);
        if (t.exitCode() !== 0) throw new Error(`expected exit 0, got ${t.exitCode()}`);
      } finally {
        t.kill();
      }
    });
  } finally {
    await restoreHomeEnv(hadBackup);
  }
}]);

// --- Scenario C: Onboarding wizard interactivity ---
tests.push(['C. Onboarding: scan renders → arrow-down → [v]iew → back → arrow-up → [e]dit → Esc → q', async () => {
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'onboarding', '--config-dir', scratchDir, '--target', TARGET_REAL]);
    try {
      await t.waitFor('scan complete', 10000);
      await t.waitFor('npm test', 3000);
      await t.waitFor(/[0-9]+ test files/, 3000);

      // Cursor starts on Runner (0). Move to Found (2).
      t.reset();
      t.sendKey('down'); await t.sleep(80);
      t.sendKey('down'); await t.sleep(80);
      t.send('v');
      await t.waitFor('matched files', 3000);

      // Back to wizard
      t.reset();
      t.send('b');
      await t.waitFor('scan complete', 3000);

      // Move cursor back to Runner (top) and open editor
      t.sendKey('up'); await t.sleep(80);
      t.sendKey('up'); await t.sleep(80);
      t.reset();
      t.send('e');
      await t.waitFor('Runner:', 3000);

      // Cancel editor
      t.reset();
      t.sendKey('esc');
      await t.waitFor('scan complete', 3000);

      // Quit
      t.send('q');
      await t.waitExit(3000);
      if (t.exitCode() !== 0) throw new Error(`expected exit 0, got ${t.exitCode()}`);
    } finally {
      t.kill();
    }
  });
}]);

// --- Scenario D: zero-tests wizard path ---
tests.push(['D. Zero tests found: wizard renders "0 test files" and blocks accept', async () => {
  const TARGET_EMPTY = path.join(os.homedir(), 'Documents/GitHub/canaryone-cloud');
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'onboarding', '--config-dir', scratchDir, '--target', TARGET_EMPTY]);
    try {
      await t.waitFor('scan complete', 10000);
      // canaryone-cloud has no test dirs -> suggestedGlob is null -> glob is "(none)" and Found is "0 test files"
      await t.waitFor(/0 test files|\(none\)/, 5000);
      // Enter should NOT advance. Don't reset() before Enter — the wizard
      // header only re-emits on state change; only body cells redraw after
      // Enter. So check the persistent-body markers still on screen.
      t.sendKey('enter');
      await t.sleep(500);
      const screen = t.screen();
      if (/Pick tasks|classified by/.test(screen)) throw new Error('accept was NOT blocked despite 0 files');
      if (!/0 test files/.test(screen)) throw new Error('expected wizard body still visible after blocked accept');
      t.send('q');
      await t.waitExit(3000);
    } finally {
      t.kill();
    }
  });
}]);

// --- Scenario E: PickModels loads real OR catalog ---
tests.push(['E. PickModels: catalog fetches from OR and renders top-ranked models', async () => {
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'pickModels', '--config-dir', scratchDir, '--target', TARGET_REAL], {
      // Preserve any real OPENROUTER_API_KEY so /credits works during test.
      clearAuth: false,
    });
    try {
      // Either we hit the loading spinner, or the catalog is already cached
      // and we go straight to the model list. Wait for either.
      await t.waitFor(/fetching model catalog|Most used on OpenRouter/, 15000);
      await t.waitFor('Most used on OpenRouter', 15000);
      // Verify at least one live-ranked model appears (top ranked models on OR
      // include gemini-2.5 / gpt-oss-120b / mimo-v2.5 / deepseek — one of these
      // should be present unless OR is completely offline).
      await t.waitFor(/gemini|gpt-oss|mimo|deepseek|glm|kimi|claude|nemotron/i, 3000);
      // Search
      t.send('/');
      await t.sleep(150);
      t.send('claude');
      await t.waitFor(/Search results/, 3000);
      t.sendKey('esc');
      await t.sleep(150);
      // Quit
      t.send('q');
      await t.waitExit(3000);
      if (t.exitCode() !== 0) throw new Error(`expected exit 0, got ${t.exitCode()}`);
    } finally {
      t.kill();
    }
  });
}]);

// --- Scenario F: PickDestinations loads real provider endpoints ---
tests.push(['F. PickDestinations: real /endpoints fetched per selected model', async () => {
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'pickDestinations', '--config-dir', scratchDir, '--target', TARGET_REAL], {
      clearAuth: false,
    });
    try {
      // The fixture-seeded default selected models are anthropic/claude-haiku-4.5,
      // deepseek/deepseek-v4-flash, z-ai/glm-5.2 (see store initial state).
      await t.waitFor(/Provider|fetching provider endpoints|Anthropic|DeepInfra/i, 15000);
      // Real provider names that come from /endpoints for those models.
      await t.waitFor(/DeepInfra|Baidu|CoreWeave|Anthropic|Novita|Fireworks/, 15000);
      // Verify at least one real "via OR" router row is on-screen.
      await t.waitFor(/via OR/, 3000);
      t.send('q');
      await t.waitExit(3000);
      if (t.exitCode() !== 0) throw new Error(`expected exit 0, got ${t.exitCode()}`);
    } finally {
      t.kill();
    }
  });
}]);

// --- Scenario G: PickModels blocks Enter when 0 models selected ---
tests.push(['G. PickModels: Enter is blocked with 0 selected, then works after space-toggle', async () => {
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'pickModels', '--config-dir', scratchDir, '--target', TARGET_REAL], { clearAuth: false });
    try {
      await t.waitFor('Most used on OpenRouter', 15000);
      // Footer should hint that Enter is blocked (0 selected).
      await t.waitFor(/enter \(pick ≥1 model\)|pick ≥1 model/, 3000);
      // Try Enter — should NOT advance.
      t.sendKey('enter');
      await t.sleep(400);
      let screen = t.screen();
      if (/Pick destinations/.test(screen)) throw new Error('advanced despite 0 models selected');
      // Toggle top model on
      t.send(' ');
      await t.sleep(200);
      // Footer should now show enter next →
      await t.waitFor(/enter next →/, 3000);
      t.send('q');
      await t.waitExit(3000);
    } finally { t.kill(); }
  });
}]);

// --- Scenario H: PickDestinations blocks Enter when a model has 0 providers ---
tests.push(['H. PickDestinations: Enter blocked with a model having 0 providers; unblocks after space', async () => {
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'pickDestinations', '--config-dir', scratchDir, '--target', TARGET_REAL], { clearAuth: false });
    try {
      await t.waitFor(/Provider/, 15000);
      await t.waitFor(/enter \(pick ≥1 provider/, 8000);
      // Try Enter — should NOT advance.
      t.sendKey('enter');
      await t.sleep(400);
      let screen = t.screen();
      if (/Confirm & run|Scope/.test(screen)) throw new Error('advanced despite 0 destinations');
      t.send('q');
      await t.waitExit(3000);
    } finally { t.kill(); }
  });
}]);

// --- Scenario I: PickTasks blocks Enter with 0 selected, unblocks after space ---
tests.push(['I. PickTasks: Enter blocked at 0 picked; space toggles then advance is allowed', async () => {
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'pickTasks', '--config-dir', scratchDir, '--target', TARGET_REAL], { clearAuth: false });
    try {
      // Fixture-fallback path renders 12 tasks all unchecked by default.
      await t.waitFor(/Pick tasks/, 5000);
      await t.waitFor(/0\/[0-9]+ selected/, 3000);
      await t.waitFor(/enter \(pick ≥1 test\)/, 3000);
      // Try Enter — should NOT advance.
      t.sendKey('enter');
      await t.sleep(400);
      let screen = t.screen();
      if (/Pick models/.test(screen)) throw new Error('advanced despite 0 tasks selected');
      // Space to toggle first task.
      t.send(' ');
      await t.sleep(200);
      await t.waitFor(/1\/[0-9]+ selected/, 3000);
      await t.waitFor(/enter next →/, 3000);
      t.send('q');
      await t.waitExit(3000);
    } finally { t.kill(); }
  });
}]);

// --- Scenario J: Confirm shows real pricing + parallelism math ---
tests.push(['J. Confirm: renders with lanes, correct parallel wall-clock', async () => {
  await withScratchDir(async (scratchDir) => {
    // --start confirm seeds 3 lanes (3 models × 1 destination each).
    const t = spawnTui(['--start', 'confirm', '--config-dir', scratchDir, '--target', TARGET_REAL], { clearAuth: false });
    try {
      await t.waitFor(/Confirm & run/, 8000);
      await t.waitFor(/Scope/, 3000);
      // "lanes (model, destination)" — old label was "(model,host)".
      await t.waitFor(/model, destination/, 3000);
      // Parallelism line names "concurrent="
      await t.waitFor(/concurrent=/, 3000);
      // Judge model displayed by name (was hidden previously).
      await t.waitFor(/claude-haiku-4\.5/, 3000);
      t.send('q');
      await t.waitExit(3000);
    } finally { t.kill(); }
  });
}]);

// --- Scenario M: nested-tests fixture auto-discovers via src/**/__tests__/ fallback ---
tests.push(['M. Onboarding: nested tests under src/**/__tests__/ auto-discovered without user edit', async () => {
  const target = path.join(FIXTURES_DIR, 'nested-tests-repo');
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'onboarding', '--config-dir', scratchDir, '--target', target], { clearAuth: false });
    try {
      await t.waitFor('scan complete', 10000);
      // Nested fallback picks up src/lib/__tests__/agent.test.js — Found row
      // should show 1 test file WITHOUT the user needing to edit the glob.
      await t.waitFor(/1 test files?/, 5000);
      // Glob row should show the nested pattern, not "(none)".
      const screen = t.screen();
      if (/\(none\)/.test(screen)) throw new Error('nested glob not populated');
      if (!/__tests__/.test(screen)) throw new Error('expected __tests__ pattern in glob');
      t.send('q');
      await t.waitExit(3000);
    } finally { t.kill(); }
  });
}]);

// --- Scenario K: MethodologyCheck ready state on sdk-env fixture; Enter advances ---
tests.push(['K. MethodologyCheck: sdk-env fixture renders verdict; Enter advances to PickTasks', async () => {
  const target = path.join(FIXTURES_DIR, 'sdk-env-repo');
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'onboarding', '--config-dir', scratchDir, '--target', target], { clearAuth: false });
    try {
      await t.waitFor('scan complete', 10000);
      t.sendKey('enter');                                     // accept onboarding → SummarizeTasks
      await t.waitFor(/summarized|all summaries ready/, 60000);
      t.reset();
      t.sendKey('enter');                                     // advance → MethodologyCheck
      await t.waitFor(/canaryone.*Methodology/, 5000);
      await t.waitFor(/✓ Detected/, 60000);                   // ready state renders
      // Verify the screen stays put — no auto-advance.
      await t.sleep(1500);
      const stayed = t.screen();
      if (/Pick tasks/.test(stayed)) throw new Error('methodology auto-advanced without user input');
      if (!/enter continue →/.test(stayed)) throw new Error('missing enter continue prompt');
      // Enter advances.
      t.reset();
      t.sendKey('enter');
      await t.waitFor(/Pick tasks/, 5000);
      t.send('q');
      await t.waitExit(3000);
    } finally { t.kill(); }
  });
}]);

// --- Scenario L: MethodologyCheck blocks on hardcoded fixture ---
tests.push(['L. MethodologyCheck: hardcoded fixture blocks with file/line + suggested env var', async () => {
  const target = path.join(FIXTURES_DIR, 'hardcoded-repo');
  await withScratchDir(async (scratchDir) => {
    const t = spawnTui(['--start', 'onboarding', '--config-dir', scratchDir, '--target', target], { clearAuth: false });
    try {
      await t.waitFor('scan complete', 10000);
      t.sendKey('enter');
      await t.waitFor(/summarized|all summaries ready/, 60000);
      t.reset();
      t.sendKey('enter');
      await t.waitFor(/canaryone.*Methodology/, 5000);
      // Match the block screen's specific heading (avoids matching 'hardcoded' inside Haiku summaries).
      await t.waitFor(/base URL is hardcoded/, 60000);
      // Verify the block screen shows either the offending URL or a suggested env var swap.
      await t.waitFor(/api\.groq\.com|OPENAI_BASE_URL|process\.env/, 5000);
      // Enter is disabled — verify we can NOT advance.
      t.sendKey('enter');
      await t.sleep(500);
      const screen = t.screen();
      if (/Pick tasks/.test(screen)) throw new Error('advanced despite sdk-hardcoded block');
      t.send('q');
      await t.waitExit(3000);
      if (t.exitCode() !== 1) throw new Error(`expected exit 1 from hardcoded-block quit, got ${t.exitCode()}`);
    } finally { t.kill(); }
  });
}]);

// --- Scenario N: ApiKeys screen renders + nav skips coming-soon rows ---
tests.push(['N. ApiKeys: 11 rows in two groups; nav skips Bedrock (coming-soon)', async () => {
  const hadBackup = await backupHomeEnv();
  try {
    await withScratchDir(async (scratchDir) => {
      const t = spawnTui(['--start', 'apiKeys', '--config-dir', scratchDir, '--target', TARGET_REAL]);
      try {
        await t.waitFor('API keys', 6000);
        await t.waitFor('Routers', 3000);
        await t.waitFor('Direct Providers', 3000);

        // All 4 routers present, incl. Bedrock as coming-soon.
        await t.waitFor('OpenRouter', 3000);
        await t.waitFor('Vercel', 3000);
        await t.waitFor('Cloudflare', 3000);
        await t.waitFor(/Bedrock.*coming soon/, 3000);

        // All 7 direct-provider rows (moonshot intl+cn collapse into one).
        await t.waitFor(/Moonshot \(intl \+ cn\)/, 3000);
        await t.waitFor('Nebius', 3000);
        await t.waitFor('Fireworks', 3000);
        await t.waitFor('Together', 3000);
        await t.waitFor('Groq', 3000);
        await t.waitFor('DeepSeek', 3000);
        await t.waitFor('Cerebras', 3000);
        await t.waitFor('More coming soon', 3000);

        // Enter is gated on OR key present. With scratchDir + backed-up
        // HOME_ENV, no OR key is set → footer must show "OR required".
        await t.waitFor('OR required', 3000);

        // Down-arrow 3× MUST skip Bedrock (coming-soon). Reset buffer so we
        // only inspect the current-frame render, not accumulated history.
        t.reset();
        t.sendKey('down');  // vercel
        await t.sleep(50);
        t.sendKey('down');  // cloudflare
        await t.sleep(50);
        t.sendKey('down');  // should skip bedrock → moonshot
        await t.sleep(300);
        const screen = t.screen();
        // Cursor glyph "▸" must be on Moonshot, NOT on Bedrock.
        if (/▸[\s]*Bedrock/.test(screen)) {
          throw new Error(`cursor landed on Bedrock — nav should skip coming-soon rows.\n${screen.slice(-1600)}`);
        }
        if (!/▸[\s]*Moonshot/.test(screen)) {
          throw new Error(`cursor did not land on Moonshot after 3 downs.\n${screen.slice(-1600)}`);
        }

        t.send('q');
        await t.waitExit(3000);
      } finally { t.kill(); }
    });
  } finally { await restoreHomeEnv(hadBackup); }
}]);

console.log('Running TUI tests via node-pty...\n');
await runTests(tests);
