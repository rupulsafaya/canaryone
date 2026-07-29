// captureGitDiff — compact summary of git changes in a session worktree.
// Feeds the Verification sub-score: zero diff on a task that should have
// modified files is a strong low-verification signal.
//
// Runs against the worktree BEFORE it's torn down (orchestrator wires this
// into runOne's finally-adjacent path — see J6).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GitDiffSummary {
  files_changed: number;
  insertions: number;
  deletions: number;
  paths: string[];    // up to 20 paths; truncated with "(+N more)" marker
  is_git: boolean;    // false when the worktree isn't a git repo (shallow-copy)
}

const MAX_PATHS = 20;

export async function captureGitDiff(worktreePath: string): Promise<GitDiffSummary> {
  const empty: GitDiffSummary = { files_changed: 0, insertions: 0, deletions: 0, paths: [], is_git: false };

  // Check that this is a git worktree first — bail fast on shallow-copy.
  try {
    await exec('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], { timeout: 5000 });
  } catch {
    return empty;
  }

  let files_changed = 0, insertions = 0, deletions = 0;
  try {
    const { stdout } = await exec('git', ['-C', worktreePath, 'diff', 'HEAD', '--shortstat'], { timeout: 5000 });
    // Example: " 3 files changed, 42 insertions(+), 5 deletions(-)"
    const m = stdout.match(/(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/);
    if (m) {
      files_changed = Number(m[1] ?? 0);
      insertions = Number(m[2] ?? 0);
      deletions = Number(m[3] ?? 0);
    }
  } catch {
    // Fall through — return whatever we could gather.
  }

  const paths: string[] = [];
  try {
    const { stdout } = await exec('git', ['-C', worktreePath, 'diff', 'HEAD', '--name-only'], { timeout: 5000 });
    const all = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (all.length > MAX_PATHS) {
      paths.push(...all.slice(0, MAX_PATHS));
      paths.push(`(+${all.length - MAX_PATHS} more)`);
    } else {
      paths.push(...all);
    }
  } catch {
    // paths stays empty
  }

  return { files_changed, insertions, deletions, paths, is_git: true };
}
