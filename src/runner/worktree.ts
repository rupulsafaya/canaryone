// Per-(task, lane, repeat) ephemeral worktree at
//   <configDir>/worktrees/<runId>/<sessionId>/
//
// Two paths:
//   - target has a .git dir → `git worktree add <path> HEAD`
//     (proper worktree; fast; source repo stays clean)
//   - target has no .git   → shallow copy (skipping node_modules/.c1/dist etc.)
//     (fixture repos, or any un-versioned target)
//
// Teardown mirrors: `git worktree remove --force` or `rm -rf`.
//
// node_modules inside the worktree is a SYMLINK to <configDir>/deps-cache/<hash>/node_modules
// so each session doesn't re-install.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

const COPY_IGNORE = new Set(['.git', 'node_modules', '.c1', 'dist', 'build', '.next', '.venv', '.turbo', 'coverage', 'out', '.cache']);

export interface Worktree {
  path: string;
  cleanup(): Promise<void>;
}

/** Create a worktree for a session. Returns absolute path + cleanup fn. */
export async function createWorktree(opts: {
  targetDir: string;
  configDir: string;
  runId: string;
  sessionId: string;
}): Promise<Worktree> {
  const { targetDir, configDir, runId, sessionId } = opts;
  const wtPath = path.join(configDir, 'worktrees', runId, sessionId);
  await fsp.mkdir(path.dirname(wtPath), { recursive: true });

  const isGit = await hasGitDir(targetDir);
  if (isGit) {
    await execFileAsync('git', ['-C', targetDir, 'worktree', 'add', '--detach', wtPath, 'HEAD'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    await propagateEnvFiles(targetDir, wtPath);
    return {
      path: wtPath,
      async cleanup() {
        try {
          await execFileAsync('git', ['-C', targetDir, 'worktree', 'remove', '--force', wtPath]);
        } catch {
          // If git worktree remove fails (e.g., dir already gone), fall through to rm.
        }
        try { await fsp.rm(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
      },
    };
  }

  // Non-git target: shallow copy.
  await copyDir(targetDir, wtPath);
  await propagateEnvFiles(targetDir, wtPath);
  return {
    path: wtPath,
    async cleanup() {
      try { await fsp.rm(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// Copy the target repo's .env files into the worktree so tests that use
// dotenv (or any framework that reads .env by convention) find their config.
// .env is typically gitignored, so `git worktree add` doesn't include it —
// tests would otherwise crash at module load on missing keys (Resend,
// Supabase, etc).
//
// Match .env* by glob rather than a curated list — every framework has its
// own precedence (Next.js, Vite, CRA, Remix, plain dotenv, custom .env.ci
// etc.). The target repo's own env-loading is the source of truth about
// which file wins; we just make them all reachable inside the ephemeral
// checkout. Excludes .env.example / .env.sample (placeholder docs, not
// real config — copying them would clobber values from a real .env).
const ENV_EXCLUDE = new Set(['.env.example', '.env.sample']);

async function propagateEnvFiles(src: string, dest: string): Promise<void> {
  let entries: string[];
  try { entries = await fsp.readdir(src); }
  catch { return; }
  await Promise.all(entries.map(async (name) => {
    if (!name.startsWith('.env')) return;
    if (ENV_EXCLUDE.has(name)) return;
    const s = path.join(src, name);
    try {
      const st = await fsp.stat(s);
      if (!st.isFile()) return;   // skip .env directories (unusual but possible)
      await fsp.copyFile(s, path.join(dest, name));
    } catch { /* non-fatal — worktree still usable */ }
  }));
}

async function hasGitDir(dir: string): Promise<boolean> {
  try {
    const st = await fsp.stat(path.join(dir, '.git'));
    return st.isDirectory() || st.isFile();   // submodule case uses .git file
  } catch { return false; }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  await Promise.all(entries.map(async (ent) => {
    if (COPY_IGNORE.has(ent.name)) return;
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      await copyDir(s, d);
    } else if (ent.isSymbolicLink()) {
      const target = await fsp.readlink(s);
      try { await fsp.symlink(target, d); } catch { /* ignore broken links */ }
    } else if (ent.isFile()) {
      await fsp.copyFile(s, d);
    }
  }));
}

// ---------- deps cache ----------

export interface DepsCacheResult {
  cacheDir: string;              // absolute path to <configDir>/deps-cache/<hash>
  nodeModulesPath: string | null; // absolute path to the installed node_modules, or null if none needed
  installed: boolean;             // true if we ran install this call
  pkgManager: 'pnpm' | 'yarn' | 'npm' | 'bun' | 'none';
}

/**
 * Ensure a shared node_modules exists for `targetDir`'s deps, then return
 * paths so callers can symlink it into worktrees.
 *
 * Cache key = SHA1(package.json content). Two targets with identical
 * package.json share the cache.
 */
export async function ensureDepsCache(opts: {
  targetDir: string;
  configDir: string;
  timeoutMs?: number;
}): Promise<DepsCacheResult> {
  const { targetDir, configDir, timeoutMs = 5 * 60 * 1000 } = opts;
  const pkgPath = path.join(targetDir, 'package.json');
  let pkgRaw: string;
  try { pkgRaw = await fsp.readFile(pkgPath, 'utf8'); }
  catch { return { cacheDir: '', nodeModulesPath: null, installed: false, pkgManager: 'none' }; }

  const hash = createHash('sha1').update(pkgRaw).digest('hex').slice(0, 16);
  const cacheDir = path.join(configDir, 'deps-cache', hash);
  const nmPath = path.join(cacheDir, 'node_modules');
  await fsp.mkdir(cacheDir, { recursive: true });

  const pkgMgr = await detectPackageManager(targetDir);

  // Check if node_modules already installed and marker file present.
  const markerPath = path.join(cacheDir, '.c1-installed');
  const marker = await readMarker(markerPath);
  if (marker && marker.pkgSha === hash) {
    return { cacheDir, nodeModulesPath: nmPath, installed: false, pkgManager: pkgMgr };
  }

  // Copy package.json (+ lockfile) into cacheDir, then install there.
  await fsp.copyFile(pkgPath, path.join(cacheDir, 'package.json'));
  const lockfile = await copyLockfile(targetDir, cacheDir, pkgMgr);
  await runInstall(cacheDir, pkgMgr, timeoutMs);
  await fsp.writeFile(markerPath, JSON.stringify({ pkgSha: hash, lockfile, at: new Date().toISOString() }));

  return { cacheDir, nodeModulesPath: nmPath, installed: true, pkgManager: pkgMgr };
}

async function detectPackageManager(targetDir: string): Promise<'pnpm' | 'yarn' | 'npm' | 'bun' | 'none'> {
  const [pnpm, yarn, bun, npmLock] = await Promise.all([
    exists(path.join(targetDir, 'pnpm-lock.yaml')),
    exists(path.join(targetDir, 'yarn.lock')),
    exists(path.join(targetDir, 'bun.lockb')),
    exists(path.join(targetDir, 'package-lock.json')),
  ]);
  if (pnpm) return 'pnpm';
  if (yarn) return 'yarn';
  if (bun) return 'bun';
  if (npmLock) return 'npm';
  // no lockfile: default to npm for now
  return 'npm';
}

async function copyLockfile(target: string, cache: string, mgr: string): Promise<string | null> {
  const map: Record<string, string> = {
    pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lockb', npm: 'package-lock.json',
  };
  const file = map[mgr];
  if (!file) return null;
  const src = path.join(target, file);
  if (!(await exists(src))) return null;
  await fsp.copyFile(src, path.join(cache, file));
  return file;
}

async function runInstall(cacheDir: string, mgr: string, timeoutMs: number): Promise<void> {
  const cmdArgs: Record<string, [string, string[]]> = {
    pnpm: ['pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile']],
    yarn: ['yarn', ['install']],
    bun: ['bun', ['install']],
    npm: ['npm', ['install', '--no-audit', '--no-fund', '--prefer-offline']],
  };
  const [cmd, args] = cmdArgs[mgr] ?? cmdArgs.npm;
  await execFileAsync(cmd, args, { cwd: cacheDir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
}

async function readMarker(p: string): Promise<{ pkgSha: string; lockfile: string | null; at: string } | null> {
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * Ensure worktreeDir/node_modules → depsCache/node_modules symlink.
 * No-op if the source cache doesn't exist (target without deps).
 */
export async function symlinkNodeModules(worktreeDir: string, depsCache: DepsCacheResult): Promise<void> {
  if (!depsCache.nodeModulesPath) return;
  const dest = path.join(worktreeDir, 'node_modules');
  // Remove any pre-existing node_modules dir in the worktree first.
  try {
    const st = await fsp.lstat(dest);
    if (st.isSymbolicLink() || st.isFile()) await fsp.unlink(dest);
    else if (st.isDirectory()) await fsp.rm(dest, { recursive: true, force: true });
  } catch { /* nothing to remove */ }
  await fsp.symlink(depsCache.nodeModulesPath, dest, 'dir');
}

/** Garbage-collect stale worktrees older than the given age. Runs on boot (opportunistic). */
export async function gcOldWorktrees(configDir: string, maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const root = path.join(configDir, 'worktrees');
  let removed = 0;
  try {
    const runIds = await fsp.readdir(root);
    for (const runId of runIds) {
      const runPath = path.join(root, runId);
      const st = await fsp.stat(runPath).catch(() => null);
      if (!st) continue;
      if (Date.now() - st.mtimeMs > maxAgeMs) {
        try { fs.rmSync(runPath, { recursive: true, force: true }); removed++; } catch { /* ignore */ }
      }
    }
  } catch { /* no worktrees root yet */ }
  return removed;
}
