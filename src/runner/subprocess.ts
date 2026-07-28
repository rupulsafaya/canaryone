// Session subprocess: spawns the task's test file with proxy env-vars swapped
// so the SDK inside points at our lane's ephemeral port.
//
// Returns:
//   - exit code
//   - stdout / stderr tails (~4 KB each; full output would balloon the JSONL)
//   - failure_class if we killed the process (timeout, cost cap, step cap)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TAIL_BYTES = 4096;

export type SubprocessFailureClass =
  | 'timeout'
  | 'cost_cap'
  | 'step_cap'
  | 'user_killed'
  | 'spawn_failed';

export interface SubprocessResult {
  exitCode: number | null;      // null when killed by signal
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  failureClass: SubprocessFailureClass | null;
}

export interface SubprocessOpts {
  runnerCmd: string;            // from config, e.g. "npm test", "pnpm test", "vitest run"
  taskFile: string;             // repo-relative path to the specific test file to run
  cwd: string;                  // worktree path
  proxyPort: number;
  runId: string;
  sessionId: string;
  lane: string;                 // "<model>@<destSlug>" — for C1_LANE
  orKey: string;
  timeoutMs: number;
  extraEnv?: Record<string, string>;
}

export function runSession(opts: SubprocessOpts): {
  promise: Promise<SubprocessResult>;
  kill: (reason: SubprocessFailureClass) => void;
} {
  const { cmd, args } = buildRunCommand(opts.runnerCmd, opts.taskFile, opts.cwd);
  const env = {
    ...process.env,
    // Base URL swap — the whole point of iter2.
    OPENAI_BASE_URL:     `http://localhost:${opts.proxyPort}/v1`,
    ANTHROPIC_BASE_URL:  `http://localhost:${opts.proxyPort}`,
    OPENROUTER_BASE_URL: `http://localhost:${opts.proxyPort}/api/v1`,
    // Metadata the subprocess can read.
    C1_RUN_ID:     opts.runId,
    C1_SESSION_ID: opts.sessionId,
    C1_LANE:       opts.lane,
    // Keep OR key around in case the target does its own fallback logic.
    OPENROUTER_API_KEY: opts.orKey,
    ...(opts.extraEnv ?? {}),
  };

  const t0 = Date.now();
  let stdoutTail = new RingBuffer(TAIL_BYTES);
  let stderrTail = new RingBuffer(TAIL_BYTES);
  let killedReason: SubprocessFailureClass | null = null;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return {
      promise: Promise.resolve({
        exitCode: null, signal: null,
        stdoutTail: '', stderrTail: `spawn failed: ${err}`,
        durationMs: 0, failureClass: 'spawn_failed',
      }),
      kill: () => { /* no child */ },
    };
  }

  child.stdout?.on('data', (b: Buffer) => stdoutTail.append(b));
  child.stderr?.on('data', (b: Buffer) => stderrTail.append(b));

  const timeoutHandle = setTimeout(() => {
    killedReason = 'timeout';
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, opts.timeoutMs);

  const promise = new Promise<SubprocessResult>((resolve) => {
    child.on('exit', (code, signal) => {
      clearTimeout(timeoutHandle);
      resolve({
        exitCode: code,
        signal,
        stdoutTail: stdoutTail.toString(),
        stderrTail: stderrTail.toString(),
        durationMs: Date.now() - t0,
        failureClass: killedReason,
      });
    });
    child.on('error', (e) => {
      clearTimeout(timeoutHandle);
      resolve({
        exitCode: null, signal: null,
        stdoutTail: stdoutTail.toString(),
        stderrTail: `${stderrTail.toString()}\n${e.message}`,
        durationMs: Date.now() - t0,
        failureClass: killedReason ?? 'spawn_failed',
      });
    });
  });

  return {
    promise,
    kill(reason: SubprocessFailureClass) {
      if (killedReason) return;
      killedReason = reason;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    },
  };
}

// ---------- runner-command heuristic ----------

/**
 * Build a runnable (cmd, args) that executes ONE specific test file. Per-task
 * granularity matters: sessions correspond to individual tests, not the whole
 * suite.
 *
 * When runnerCmd is a package-manager wrapper (`npm test`, `pnpm test`, etc.),
 * we peek at cwd/package.json:scripts.test and re-classify against the
 * underlying command — that's the only way to get file-level filtering.
 */
export function buildRunCommand(runnerCmd: string, taskFile: string, cwd?: string): { cmd: string; args: string[] } {
  const trimmed = runnerCmd.trim();
  const resolved = resolvePmWrapper(trimmed, cwd);
  return classifyRunCommand(resolved, taskFile);
}

function classifyRunCommand(cmd: string, taskFile: string): { cmd: string; args: string[] } {
  const trimmed = cmd.trim();
  if (/(^|\s)node\s+--test\b/.test(trimmed)) {
    return { cmd: 'node', args: ['--test', taskFile] };
  }
  if (/vitest/.test(trimmed)) {
    return { cmd: 'npx', args: ['--yes', 'vitest', 'run', taskFile] };
  }
  if (/jest/.test(trimmed)) {
    return { cmd: 'npx', args: ['--yes', 'jest', taskFile] };
  }
  if (/pytest/.test(trimmed)) {
    return { cmd: 'pytest', args: [taskFile] };
  }
  // Falls through to the raw command — may run more than the target task.
  const parts = trimmed.split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

// Resolve `npm test` / `pnpm test` / `yarn test` / `bun test` to the underlying
// package.json:scripts.test value if the target repo lives at cwd.
function resolvePmWrapper(runnerCmd: string, cwd?: string): string {
  if (!cwd) return runnerCmd;
  const m = runnerCmd.match(/^(npm|pnpm|yarn|bun)\s+(?:run\s+)?(\w[\w:-]*)/);
  if (!m) return runnerCmd;
  const scriptName = m[2];
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const script = pkg?.scripts?.[scriptName];
    if (typeof script === 'string' && script.trim().length > 0) return script;
  } catch { /* ignore */ }
  return runnerCmd;
}

// ---------- ring buffer for output tails ----------

class RingBuffer {
  private chunks: Buffer[] = [];
  private total = 0;
  constructor(private readonly max: number) {}

  append(buf: Buffer): void {
    this.chunks.push(buf);
    this.total += buf.length;
    while (this.total > this.max && this.chunks.length > 1) {
      const first = this.chunks.shift()!;
      this.total -= first.length;
    }
  }

  toString(): string {
    const joined = Buffer.concat(this.chunks);
    if (joined.length <= this.max) return joined.toString('utf8');
    return joined.slice(joined.length - this.max).toString('utf8');
  }
}

// Utility: resolve a relative task file against a worktree cwd. Kept here so
// orchestrator doesn't need to reach into subprocess.
export function taskFileInWorktree(worktreeDir: string, relFile: string): string {
  return path.resolve(worktreeDir, relFile);
}
