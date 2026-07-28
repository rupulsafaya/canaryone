import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigSchema, ScanSchema, type Config, type Scan, type ORKeySource } from '../data/schema.js';
import { scanDeterministic, fingerprintMtimes, type DeterministicScan } from './deterministic.js';

export const HOME_CONFIG_DIR = path.join(os.homedir(), '.c1');
export const HOME_ENV_PATH = path.join(HOME_CONFIG_DIR, '.env');

export interface FirstRunResult {
  scan: DeterministicScan;
  config: Config | null;
  orKey: { present: boolean; source: ORKeySource | null };
}

export interface RunFirstRunScanOpts {
  targetDir: string;
  configDir: string;
  forceRescan?: boolean;
}

export async function runFirstRunScan(opts: RunFirstRunScanOpts): Promise<FirstRunResult> {
  const { targetDir, configDir, forceRescan = false } = opts;
  await fs.mkdir(configDir, { recursive: true });

  const [cachedScan, cachedConfig, currentFingerprint] = await Promise.all([
    readScanCache(configDir),
    readConfig(configDir),
    fingerprintMtimes(targetDir),
  ]);

  let scan: DeterministicScan;
  const fingerprintMatch =
    cachedScan &&
    cachedScan.fingerprint.packageJsonMtime === currentFingerprint.packageJsonMtime &&
    cachedScan.fingerprint.pyprojectMtime === currentFingerprint.pyprojectMtime &&
    cachedScan.fingerprint.makefileMtime === currentFingerprint.makefileMtime;

  if (cachedScan && fingerprintMatch && !forceRescan) {
    scan = {
      runners: cachedScan.runners,
      probedDirs: cachedScan.probedDirs,
      frameworkHints: cachedScan.frameworkHints,
      // Prefer the cached, previously-computed suggestion (includes nested
      // fallbacks). Fall back to recomputing from shallow probed dirs for
      // pre-existing caches that predate the field.
      suggestedGlob: cachedScan.suggestedGlob ?? firstNonEmptyDir(cachedScan.probedDirs),
    };
  } else {
    scan = await scanDeterministic(targetDir);
    await writeScanCache(configDir, scan, currentFingerprint);
  }

  const detected = await detectOrKey(configDir);
  const orKey = { present: detected.present, source: detected.source };

  return { scan, config: cachedConfig, orKey };
}

function firstNonEmptyDir(probedDirs: Scan['probedDirs']): string | null {
  const hit = probedDirs.find((d) => d.exists && d.fileCount > 0);
  if (!hit) return null;
  const trimmed = hit.path.endsWith('/') ? hit.path : hit.path + '/';
  return trimmed + '**/*.{spec,test}.{ts,tsx,js,mjs,cjs,py}';
}

async function readScanCache(configDir: string): Promise<Scan | null> {
  const p = path.join(configDir, 'scan.json');
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = ScanSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeScanCache(
  configDir: string,
  scan: DeterministicScan,
  fingerprint: Scan['fingerprint'],
): Promise<void> {
  const now = new Date().toISOString();
  const payload: Scan = {
    version: '0.0',
    scannedAt: now,
    fingerprint,
    runners: scan.runners,
    probedDirs: scan.probedDirs,
    frameworkHints: scan.frameworkHints,
    suggestedGlob: scan.suggestedGlob,
  };
  await fs.writeFile(path.join(configDir, 'scan.json'), JSON.stringify(payload, null, 2));
}

export async function readConfig(configDir: string): Promise<Config | null> {
  const p = path.join(configDir, 'config.json');
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = ConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeConfig(configDir: string, config: Config): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
  const p = path.join(configDir, 'config.json');
  await fs.writeFile(p, JSON.stringify(config, null, 2));
}

export async function detectOrKey(_configDir?: string): Promise<{
  present: boolean;
  source: ORKeySource | null;
  value: string | null;
}> {
  if (process.env.OPENROUTER_API_KEY) {
    return { present: true, source: 'env:OPENROUTER_API_KEY', value: process.env.OPENROUTER_API_KEY };
  }
  const homeKey = await readOrKeyFromDotenv(HOME_ENV_PATH);
  if (homeKey) return { present: true, source: '~/.c1/.env', value: homeKey };
  return { present: false, source: null, value: null };
}

async function readOrKeyFromDotenv(envPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    const m = raw.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+?)\s*$/m);
    if (!m) return null;
    const val = m[1].replace(/^["']|["']$/g, '').trim();
    return val.length ? val : null;
  } catch {
    return null;
  }
}

export async function writeOrKeyToHomeDotenv(key: string): Promise<string> {
  const trimmed = key.trim();
  await fs.mkdir(HOME_CONFIG_DIR, { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(HOME_ENV_PATH, 'utf8');
  } catch {
    // new file
  }
  const filtered = existing
    .split('\n')
    .filter((line) => !/^\s*OPENROUTER_API_KEY\s*=/.test(line))
    .join('\n');
  const joined = filtered.trim().length ? filtered.trimEnd() + '\n' : '';
  const next = `${joined}OPENROUTER_API_KEY=${trimmed}\n`;
  await fs.writeFile(HOME_ENV_PATH, next, { mode: 0o600 });
  return HOME_ENV_PATH;
}

export interface OrCreditsResult {
  ok: boolean;
  credits: number | null;
  error: string | null;
}

const CREDITS_CACHE_TTL_MS = 5 * 60 * 1000;
const creditsCache = new Map<string, { at: number; result: OrCreditsResult }>();

export async function validateOrKey(key: string): Promise<OrCreditsResult> {
  const trimmed = key.trim();
  const cached = creditsCache.get(trimmed);
  const nowMs = new Date().getTime();
  if (cached && nowMs - cached.at < CREDITS_CACHE_TTL_MS) return cached.result;
  let result: OrCreditsResult;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { authorization: `Bearer ${trimmed}` },
    });
    if (!res.ok) {
      result = { ok: false, credits: null, error: `HTTP ${res.status}` };
    } else {
      const body: any = await res.json();
      const total = Number(body?.data?.total_credits ?? 0);
      const used = Number(body?.data?.total_usage ?? 0);
      const remaining = Number.isFinite(total - used) ? total - used : null;
      result = { ok: true, credits: remaining, error: null };
    }
  } catch (e) {
    result = { ok: false, credits: null, error: e instanceof Error ? e.message : String(e) };
  }
  creditsCache.set(trimmed, { at: nowMs, result });
  return result;
}

export async function ensureGitignore(targetDir: string, configDir: string): Promise<void> {
  const relConfig = path.relative(targetDir, configDir);
  if (relConfig.startsWith('..') || path.isAbsolute(relConfig)) return;
  const gitignorePath = path.join(targetDir, '.gitignore');
  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    // new file
  }
  const marker = relConfig.endsWith('/') ? relConfig : relConfig + '/';
  const hasEntry = existing
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === marker || l === marker.replace(/\/$/, '') || l === '/' + marker);
  if (hasEntry) return;
  const suffix = existing.length && !existing.endsWith('\n') ? '\n' : '';
  await fs.writeFile(gitignorePath, existing + suffix + marker + '\n');
}
