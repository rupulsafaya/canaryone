import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { RunnerCandidate, ProbedDir } from '../data/schema.js';
import { expandGlob } from './glob.js';

export interface DeterministicScan {
  runners: RunnerCandidate[];
  probedDirs: ProbedDir[];
  frameworkHints: string[];
  suggestedGlob: string | null;
}

const TEST_DIR_CANDIDATES = [
  'tests/agent',
  'tests/agents',
  'test/agent',
  '__tests__/agent',
  'tests/integration',
  'tests/e2e',
  'tests',
  'test',
  '__tests__',
];

// Fallback patterns tried when no shallow candidate has files. Ordered from
// most-scoped to least-scoped — the first pattern with matches wins.
// Common in Next.js / monorepo layouts where tests live next to source.
const NESTED_TEST_PATTERNS = [
  'src/**/__tests__/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
  'packages/*/src/**/__tests__/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
  'packages/*/{tests,test,__tests__}/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
  'apps/*/{tests,test,__tests__}/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
  'src/**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
  '**/*.{test,spec}.{ts,tsx,js,mjs,cjs,py}',
];

// Directories we never want to search in for tests, regardless of pattern.
const TEST_SEARCH_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.venv/**',
  '**/coverage/**',
  '**/.turbo/**',
  '**/out/**',
  '**/.cache/**',
];

const FRAMEWORK_FINGERPRINTS = [
  '.opencode',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'nx.json',
  'langchain.yaml',
  'mastra.config.ts',
  'mastra.config.js',
  'vitest.config.ts',
  'vitest.config.js',
  'jest.config.ts',
  'jest.config.js',
  'playwright.config.ts',
  'pytest.ini',
];

const SCRIPT_PRIORITY: Record<string, number> = {
  test: 100,
  'test:agent': 95,
  'test:unit': 90,
  'test:integration': 80,
  'test:e2e': 70,
};

export async function scanDeterministic(targetDir: string): Promise<DeterministicScan> {
  const [pkgRunners, pyRunner, makeRunner, probedDirs, frameworkHints] = await Promise.all([
    readPackageScripts(targetDir),
    readPyproject(targetDir),
    readMakefile(targetDir),
    probeTestDirs(targetDir),
    detectFrameworkHints(targetDir),
  ]);

  const runners = [...pkgRunners, ...pyRunner, ...makeRunner].sort((a, b) => b.priority - a.priority);
  if (runners.length === 0) {
    runners.push({ cmd: 'npm test', source: 'fallback', priority: 0 });
  }

  const firstNonEmpty = probedDirs.find((d) => d.exists && d.fileCount > 0);
  let suggestedGlob = firstNonEmpty ? expandGlob(firstNonEmpty.path) : null;
  // If shallow probing missed (common in Next.js repos with src/**/__tests__/
  // or monorepos), try nested patterns and take the first with matches.
  if (!suggestedGlob) suggestedGlob = await probeNestedTestGlobs(targetDir);

  return { runners, probedDirs, frameworkHints, suggestedGlob };
}

async function probeNestedTestGlobs(targetDir: string): Promise<string | null> {
  for (const pattern of NESTED_TEST_PATTERNS) {
    const hits = await fg(pattern, {
      cwd: targetDir,
      onlyFiles: true,
      dot: false,
      suppressErrors: true,
      ignore: TEST_SEARCH_IGNORE,
    });
    if (hits.length > 0) return pattern;
  }
  return null;
}

async function readPackageScripts(targetDir: string): Promise<RunnerCandidate[]> {
  const pkgPath = path.join(targetDir, 'package.json');
  const raw = await safeReadJson(pkgPath);
  if (!raw || typeof raw !== 'object') return [];
  const scripts = (raw as { scripts?: Record<string, string> }).scripts;
  if (!scripts) return [];

  const pkgMgr = await detectPackageManager(targetDir);
  const out: RunnerCandidate[] = [];
  for (const scriptName of Object.keys(scripts)) {
    if (!/^test(:.*)?$/.test(scriptName)) continue;
    const priority = SCRIPT_PRIORITY[scriptName] ?? 60;
    out.push({
      cmd: `${pkgMgr} ${scriptName === 'test' ? 'test' : `run ${scriptName}`}`,
      source: `package.json:${scriptName}`,
      priority,
    });
  }
  return out;
}

async function detectPackageManager(targetDir: string): Promise<'pnpm' | 'yarn' | 'npm' | 'bun'> {
  const [pnpm, yarn, bun] = await Promise.all([
    exists(path.join(targetDir, 'pnpm-lock.yaml')),
    exists(path.join(targetDir, 'yarn.lock')),
    exists(path.join(targetDir, 'bun.lockb')),
  ]);
  if (pnpm) return 'pnpm';
  if (yarn) return 'yarn';
  if (bun) return 'bun';
  return 'npm';
}

async function readPyproject(targetDir: string): Promise<RunnerCandidate[]> {
  const pyPath = path.join(targetDir, 'pyproject.toml');
  const raw = await safeReadText(pyPath);
  if (!raw) return [];
  const out: RunnerCandidate[] = [];
  if (/\[tool\.pytest[\.\]]/.test(raw)) {
    out.push({ cmd: 'pytest', source: 'pyproject.toml', priority: 50 });
  }
  if (/\[tool\.poetry\.scripts\]/.test(raw)) {
    out.push({ cmd: 'poetry run pytest', source: 'pyproject.toml:poetry', priority: 45 });
  }
  return out;
}

async function readMakefile(targetDir: string): Promise<RunnerCandidate[]> {
  const mkPath = path.join(targetDir, 'Makefile');
  const raw = await safeReadText(mkPath);
  if (!raw) return [];
  if (/^test\s*:/m.test(raw)) {
    return [{ cmd: 'make test', source: 'Makefile:test', priority: 40 }];
  }
  return [];
}

async function probeTestDirs(targetDir: string): Promise<ProbedDir[]> {
  const results = await Promise.all(
    TEST_DIR_CANDIDATES.map(async (rel) => {
      const abs = path.join(targetDir, rel);
      const dirExists = await exists(abs);
      if (!dirExists) return { path: rel, exists: false, fileCount: 0 };
      const files = await fg(`${rel}/**/*.{spec,test}.{ts,tsx,js,mjs,cjs,py}`, {
        cwd: targetDir,
        onlyFiles: true,
        dot: false,
        suppressErrors: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });
      return { path: rel, exists: true, fileCount: files.length };
    }),
  );
  return results;
}

async function detectFrameworkHints(targetDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of FRAMEWORK_FINGERPRINTS) {
    if (await exists(path.join(targetDir, name))) out.push(name);
  }
  return out;
}

async function safeReadJson(p: string): Promise<unknown | null> {
  const raw = await safeReadText(p);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function safeReadText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function fingerprintMtimes(targetDir: string): Promise<{
  packageJsonMtime: number | null;
  pyprojectMtime: number | null;
  makefileMtime: number | null;
}> {
  const [pkg, py, mk] = await Promise.all([
    mtime(path.join(targetDir, 'package.json')),
    mtime(path.join(targetDir, 'pyproject.toml')),
    mtime(path.join(targetDir, 'Makefile')),
  ]);
  return { packageJsonMtime: pkg, pyprojectMtime: py, makefileMtime: mk };
}

async function mtime(p: string): Promise<number | null> {
  try {
    const s = await fs.stat(p);
    return s.mtimeMs;
  } catch {
    return null;
  }
}
