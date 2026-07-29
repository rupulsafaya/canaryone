// Read / write / delete helpers for ~/.c1/.env.
//
// Preserves comments, blank lines, and the order of existing keys. New keys
// are appended at the end. Rewrites are atomic (tmp + rename) so a crash
// mid-write can't produce a torn file. Mode 0o600 on every write.
//
// A1's providers.ts has its own minimal readDotenvKey — this module is the
// full replacement; A6 wires providers.ts through it once the store landing
// is ready.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HOME_C1_DIR = path.join(os.homedir(), '.c1');
const HOME_ENV_PATH = path.join(HOME_C1_DIR, '.env');

export interface EnvFileEntry {
  key: string;
  value: string;
}

export interface ReadEnvFileResult {
  /** Ordered by first-appearance. Duplicate keys collapse to the last-written value. */
  entries: EnvFileEntry[];
  /** Convenience lookup — same values as `entries`, keyed by env name. */
  map: Record<string, string>;
  /** Full file text or empty string if the file doesn't exist. */
  raw: string;
}

/**
 * Read and parse ~/.c1/.env (or `envPath` override). Missing file is not an
 * error — returns an empty result. Malformed lines are skipped silently to
 * match dotenv's forgiving behavior.
 */
export async function readEnvFile(envPath: string = HOME_ENV_PATH): Promise<ReadEnvFileResult> {
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return { entries: [], map: {}, raw: '' };
  }
  const entries: EnvFileEntry[] = [];
  const map: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    // Last-write-wins for duplicate keys, but preserve first-appearance order
    // in the entries array so writes don't reorder existing keys.
    const existingIx = entries.findIndex((e) => e.key === parsed.key);
    if (existingIx >= 0) {
      entries[existingIx] = parsed;
    } else {
      entries.push(parsed);
    }
    map[parsed.key] = parsed.value;
  }
  return { entries, map, raw };
}

/**
 * Convenience wrapper — returns just the value for a single key, or null if
 * missing / empty. Matches the semantics providers.getApiKey() expects.
 */
export async function readEnvValue(
  key: string,
  envPath: string = HOME_ENV_PATH,
): Promise<string | null> {
  const { map } = await readEnvFile(envPath);
  const v = map[key];
  return v && v.length ? v : null;
}

/**
 * Write or update a single KEY=value. If the key already exists, its line is
 * updated in-place (preserving position + surrounding comments). If new, it's
 * appended to the end. Trims whitespace and strips surrounding quotes from
 * `value` before writing.
 *
 * Values that need quoting (contain whitespace, quotes, or leading/trailing
 * spaces) are wrapped in double quotes; simple values are written bare to
 * match the existing file style.
 */
export async function writeEnvVar(
  key: string,
  value: string,
  envPath: string = HOME_ENV_PATH,
): Promise<void> {
  assertValidKey(key);
  const cleaned = cleanValue(value);
  await fs.mkdir(path.dirname(envPath), { recursive: true });

  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    // new file
  }

  const lineToWrite = formatLine(key, cleaned);
  const lines = raw.length ? raw.split('\n') : [];

  // Find the LAST occurrence of the key (in case an earlier duplicate exists,
  // updating the last one keeps parse semantics — last-write-wins — consistent
  // with readEnvFile's behavior).
  let updatedIx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (matchesKey(lines[i], key)) { updatedIx = i; break; }
  }

  let next: string;
  if (updatedIx >= 0) {
    lines[updatedIx] = lineToWrite;
    next = lines.join('\n');
    if (!next.endsWith('\n')) next += '\n';
  } else {
    // Append. Ensure exactly one blank line separator so `KEY=` blocks read
    // cleanly, but don't add gratuitous blanks to an empty file.
    const trimmed = raw.trimEnd();
    next = trimmed.length ? `${trimmed}\n${lineToWrite}\n` : `${lineToWrite}\n`;
  }

  await atomicWrite(envPath, next);
}

/**
 * Write multiple keys in a single pass. Preferred over calling writeEnvVar in
 * a loop when adding several vars at once (e.g. Cloudflare's 2-field setup).
 */
export async function writeEnvVars(
  vars: Record<string, string>,
  envPath: string = HOME_ENV_PATH,
): Promise<void> {
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    // new
  }
  const lines = raw.length ? raw.split('\n') : [];
  const appended: string[] = [];

  for (const [key, value] of Object.entries(vars)) {
    assertValidKey(key);
    const cleaned = cleanValue(value);
    const lineToWrite = formatLine(key, cleaned);
    let updatedIx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (matchesKey(lines[i], key)) { updatedIx = i; break; }
    }
    if (updatedIx >= 0) lines[updatedIx] = lineToWrite;
    else appended.push(lineToWrite);
  }

  let next = lines.join('\n');
  if (appended.length) {
    const trimmed = next.trimEnd();
    next = trimmed.length
      ? `${trimmed}\n${appended.join('\n')}\n`
      : `${appended.join('\n')}\n`;
  } else if (!next.endsWith('\n') && next.length) {
    next += '\n';
  }
  await atomicWrite(envPath, next);
}

/**
 * Remove a key from the file (all occurrences, comment-preserving). No-op
 * when the key isn't present.
 */
export async function deleteEnvVar(
  key: string,
  envPath: string = HOME_ENV_PATH,
): Promise<void> {
  assertValidKey(key);
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return;
  }
  const lines = raw.split('\n');
  const kept = lines.filter((line) => !matchesKey(line, key));
  if (kept.length === lines.length) return;  // no change
  let next = kept.join('\n');
  if (!next.endsWith('\n') && next.length) next += '\n';
  await atomicWrite(envPath, next);
}

/**
 * Bulk delete. Same shape as deleteEnvVar — no-op per missing key.
 */
export async function deleteEnvVars(
  keys: string[],
  envPath: string = HOME_ENV_PATH,
): Promise<void> {
  for (const k of keys) assertValidKey(k);
  const set = new Set(keys);
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return;
  }
  const lines = raw.split('\n');
  const kept = lines.filter((line) => {
    for (const k of set) {
      if (matchesKey(line, k)) return false;
    }
    return true;
  });
  if (kept.length === lines.length) return;
  let next = kept.join('\n');
  if (!next.endsWith('\n') && next.length) next += '\n';
  await atomicWrite(envPath, next);
}

// ---------- Internals ----------

function parseLine(line: string): EnvFileEntry | null {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  const key = m[1];
  let value = m[2];
  // Strip a trailing inline comment ONLY when it's not inside quotes. Bare
  // values with a `#` mid-token are rare; the conservative rule is: comment
  // starts at the first ` #` (space + hash) on unquoted values.
  const isQuoted = /^["'].*["']\s*$/.test(value.trim())
    || /^["']/.test(value.trim());  // opened quote, may extend
  if (!isQuoted) {
    const hashIx = value.indexOf(' #');
    if (hashIx >= 0) value = value.slice(0, hashIx);
  }
  value = value.trim();
  // Strip a matched pair of surrounding quotes.
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function matchesKey(line: string, key: string): boolean {
  const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  return re.test(line);
}

function cleanValue(value: string): string {
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"'))
    || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

function formatLine(key: string, value: string): string {
  const needsQuoting = /[\s"'#]/.test(value) || value !== value.trim();
  if (needsQuoting) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `${key}="${escaped}"`;
  }
  return `${key}=${value}`;
}

function assertValidKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid env var name: ${JSON.stringify(key)}`);
  }
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const dir = path.dirname(target);
  const rand = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(dir, `.env.tmp-${rand}`);
  await fs.writeFile(tmp, contents, { mode: 0o600 });
  await fs.rename(tmp, target);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exported for tests / callers that want to know the default path.
export const HOME_ENV_PATH_FOR_TESTS = HOME_ENV_PATH;
