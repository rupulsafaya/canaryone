// Route pick persistence — ~/.c1/picks.json.
// Simple {picked: string[]} shape; loaded on PickRoutes mount and rewritten
// on every toggle. Missing file, malformed JSON, or wrong shape → empty
// (silent). Mode 0o600 on every write.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HOME_C1_DIR = path.join(os.homedir(), '.c1');
const PICKS_PATH = path.join(HOME_C1_DIR, 'picks.json');

export interface RoutePicks {
  /** Route IDs (form: `${providerSlug}::${wireSlug}`). */
  picked: string[];
}

export async function loadRoutePicks(picksPath: string = PICKS_PATH): Promise<RoutePicks> {
  try {
    const raw = await fs.readFile(picksPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.picked)) {
      return { picked: parsed.picked.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0) };
    }
    return { picked: [] };
  } catch {
    return { picked: [] };
  }
}

export async function saveRoutePicks(
  picks: RoutePicks,
  picksPath: string = PICKS_PATH,
): Promise<void> {
  await fs.mkdir(path.dirname(picksPath), { recursive: true });
  const rand = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(path.dirname(picksPath), `.picks.tmp-${rand}`);
  await fs.writeFile(tmp, JSON.stringify(picks, null, 2), { mode: 0o600 });
  await fs.rename(tmp, picksPath);
}

export const PICKS_PATH_FOR_TESTS = PICKS_PATH;
