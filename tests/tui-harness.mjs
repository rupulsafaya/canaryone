import * as pty from 'node-pty';

// ANSI-aware buffer: strips CSI/OSC sequences and cursor moves so pattern matches
// don't have to escape colors. Retains the printable text layout.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;

export function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

export function spawnTui(args, opts = {}) {
  const env = { ...process.env, TERM: 'xterm-256color', ...(opts.env ?? {}) };
  // Force clean auth env unless caller provides
  if (opts.clearAuth !== false) delete env.OPENROUTER_API_KEY;

  const tsxBin = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
  const cliEntry = new URL('../src/cli.tsx', import.meta.url).pathname;
  const p = pty.spawn(tsxBin, [cliEntry, ...args], {
    name: 'xterm-256color',
    cols: opts.cols ?? 160,
    rows: opts.rows ?? 40,
    cwd: opts.cwd ?? new URL('..', import.meta.url).pathname,
    env,
  });

  let buffer = '';
  let stripped = '';
  const listeners = new Set();
  p.onData((chunk) => {
    buffer += chunk;
    stripped += stripAnsi(chunk);
    for (const l of listeners) l();
  });

  let exitCode = null;
  let exitPromise = new Promise((resolve) => {
    p.onExit((e) => { exitCode = e.exitCode; resolve(e); });
  });

  return {
    /** Wait for a substring or regex to appear in the (ansi-stripped) buffer. */
    async waitFor(pattern, timeoutMs = 8000) {
      const isRe = pattern instanceof RegExp;
      const check = () => {
        if (isRe) {
          const m = stripped.match(pattern);
          if (m) return m;
        } else if (stripped.includes(pattern)) {
          return [pattern];
        }
        return null;
      };
      const hit = check();
      if (hit) return hit;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(cb);
          reject(new Error(`waitFor(${pattern}) timeout after ${timeoutMs}ms\n--- last 1500 chars ---\n${stripped.slice(-1500)}`));
        }, timeoutMs);
        const cb = () => {
          const h = check();
          if (h) {
            clearTimeout(timer);
            listeners.delete(cb);
            resolve(h);
          }
        };
        listeners.add(cb);
      });
    },

    /** Consume everything currently in the buffer so future waitFor starts fresh. */
    reset() {
      buffer = '';
      stripped = '';
    },

    send(text) {
      p.write(text);
    },

    sendKey(name) {
      const K = {
        enter:  '\r',
        return: '\r',
        esc:    '\x1b',
        escape: '\x1b',
        tab:    '\t',
        up:     '\x1b[A',
        down:   '\x1b[B',
        right:  '\x1b[C',
        left:   '\x1b[D',
        backspace: '\x7f',
      };
      const seq = K[name.toLowerCase()];
      if (!seq) throw new Error(`unknown key: ${name}`);
      p.write(seq);
    },

    /** Wait N ms — needed only for very-fast state transitions we can't observe. */
    sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },

    /** Screen buffer, ansi-stripped. */
    screen() { return stripped; },
    rawScreen() { return buffer; },

    exitCode() { return exitCode; },
    async waitExit(timeoutMs = 5000) {
      const t = new Promise((_, rej) => setTimeout(() => rej(new Error('exit timeout')), timeoutMs));
      return Promise.race([exitPromise, t]);
    },

    kill() {
      try { p.kill(); } catch { /* already exited */ }
    },
  };
}

// Tiny test runner — collect + report; each test is a fn returning a promise.
export async function runTests(tests) {
  const results = [];
  for (const [name, fn] of tests) {
    process.stdout.write(`  ${name} ... `);
    try {
      await fn();
      process.stdout.write('OK\n');
      results.push({ name, ok: true });
    } catch (e) {
      process.stdout.write('FAIL\n');
      process.stdout.write(`    ${e.message}\n`);
      results.push({ name, ok: false, error: e });
    }
  }
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} passed${failed ? ` · ${failed} failed` : ''}`);
  if (failed) process.exit(1);
}
