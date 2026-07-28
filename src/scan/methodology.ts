import fs from 'node:fs/promises';
import path from 'node:path';
import type { MethodologyReport } from '../data/schema.js';
import { MethodologyReportSchema } from '../data/schema.js';
import type { MatchedFile } from './glob.js';
import { detectOrKey } from './orchestrator.js';

export const METHODOLOGY_MODEL = 'anthropic/claude-haiku-4.5';
const MAX_BYTES_PER_FILE = 8_192;
const MAX_TOTAL_BYTES = 300_000;

// Package name (bare specifier's first segment for scoped: `@scope/name`) → SDK identity.
// Feed to Haiku so it knows what SDK is in play without wading node_modules.
const SDK_MAP: Record<string, { sdk: string; envVar: string | null }> = {
  'openai':                { sdk: 'openai',            envVar: 'OPENAI_BASE_URL' },
  '@anthropic-ai/sdk':     { sdk: 'anthropic-sdk',     envVar: 'ANTHROPIC_BASE_URL' },
  '@anthropic-ai/bedrock-sdk': { sdk: 'anthropic-bedrock', envVar: 'ANTHROPIC_BEDROCK_BASE_URL' },
  '@anthropic-ai/vertex-sdk':  { sdk: 'anthropic-vertex',  envVar: 'ANTHROPIC_VERTEX_BASE_URL' },
  'ai':                    { sdk: 'ai (Vercel)',       envVar: null },
  '@ai-sdk/openai':        { sdk: 'ai-sdk-openai',     envVar: 'OPENAI_BASE_URL' },
  '@ai-sdk/anthropic':     { sdk: 'ai-sdk-anthropic',  envVar: 'ANTHROPIC_BASE_URL' },
  '@ai-sdk/google':        { sdk: 'ai-sdk-google',     envVar: null },
  '@openrouter/ai-sdk-provider': { sdk: 'ai-sdk-openrouter', envVar: 'OPENROUTER_BASE_URL' },
  'openrouter':            { sdk: 'openrouter',        envVar: 'OPENROUTER_BASE_URL' },
  'openrouter-client':     { sdk: 'openrouter',        envVar: 'OPENROUTER_BASE_URL' },
  'langchain':             { sdk: 'langchain',         envVar: null },
  '@langchain/openai':     { sdk: 'langchain-openai',  envVar: 'OPENAI_BASE_URL' },
  '@langchain/anthropic':  { sdk: 'langchain-anthropic', envVar: 'ANTHROPIC_BASE_URL' },
  '@langchain/core':       { sdk: 'langchain-core',    envVar: null },
  '@langchain/community':  { sdk: 'langchain-community', envVar: null },
  '@mastra/core':          { sdk: 'mastra',            envVar: null },
  '@mastra/agent':         { sdk: 'mastra',            envVar: null },
  'litellm':               { sdk: 'litellm',           envVar: 'OPENAI_BASE_URL' },
  'llamaindex':            { sdk: 'llamaindex',        envVar: null },
  'llama-index':           { sdk: 'llamaindex',        envVar: null },
  'llama_index':           { sdk: 'llamaindex',        envVar: null },
  'anthropic':             { sdk: 'anthropic-py',      envVar: 'ANTHROPIC_BASE_URL' },
};

// Extensions we resolve for TS/JS relative imports.
const TSJS_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'];
const PY_EXTS = ['.py'];

const IS_TSJS = (p: string) => /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i.test(p);
const IS_PY = (p: string) => /\.py$/i.test(p);

export interface MethodologyInput {
  testFiles: MatchedFile[];
  targetDir: string;
}

export interface MethodologyResult {
  report: MethodologyReport;
  bundleBytes: number;
  sdkImports: string[];         // union of SDK identities detected in the bundle (informational)
}

export async function runMethodology(input: MethodologyInput): Promise<MethodologyResult> {
  const detected = await detectOrKey();
  if (!detected.value) throw new Error('No OpenRouter key — cannot run methodology check.');
  const orKey = detected.value;

  const { bundle, followedFiles, sdkImports, bundleBytes } = await assembleBundle(input);
  const parsed = await callHaiku(orKey, bundle, sdkImports);

  const report: MethodologyReport = MethodologyReportSchema.parse({
    state: parsed.state,
    primarySdk: parsed.primarySdk ?? null,
    otherSdks: parsed.otherSdks ?? [],
    evidence: String(parsed.evidence ?? '').slice(0, 500),
    hardcodedSites: parsed.hardcodedSites,
    followedFiles,
    scannedAt: new Date().toISOString(),
    model: METHODOLOGY_MODEL,
  });

  return { report, bundleBytes, sdkImports };
}

/** Check if a cached report is still valid: no followedFile's mtime is newer than scannedAt. */
export async function isMethodologyFresh(
  report: MethodologyReport,
  targetDir: string,
): Promise<boolean> {
  const scannedAtMs = Date.parse(report.scannedAt);
  if (!Number.isFinite(scannedAtMs)) return false;
  for (const rel of report.followedFiles) {
    const abs = path.resolve(targetDir, rel);
    try {
      const st = await fs.stat(abs);
      if (st.mtimeMs > scannedAtMs) return false;
    } catch {
      // File was removed — treat as stale.
      return false;
    }
  }
  return true;
}

// ---------- Bundle assembly ----------

interface BundleShape {
  bundle: string;
  followedFiles: string[];          // repo-relative paths, sorted
  sdkImports: string[];             // unique SDK identities detected
  bundleBytes: number;
}

async function assembleBundle(input: MethodologyInput): Promise<BundleShape> {
  const { testFiles, targetDir } = input;
  const tsconfigPaths = await readTsconfigPaths(targetDir);

  // Absolute paths already walked, so we don't re-parse them.
  const walked = new Set<string>();
  // Queue of absolute paths still to walk.
  const queue: string[] = [];
  // Track SDK identities we saw as bare imports anywhere.
  const sdkImports = new Set<string>();

  for (const tf of testFiles) queue.push(tf.absolute);

  while (queue.length) {
    const abs = queue.shift()!;
    if (walked.has(abs)) continue;
    walked.add(abs);

    const src = await tryReadCapped(abs);
    if (src === null) continue;

    const specs = extractImportSpecifiers(abs, src);
    for (const spec of specs) {
      const cls = classifySpecifier(spec, targetDir);
      if (cls.kind === 'sdk') {
        sdkImports.add(cls.sdk);
        continue;
      }
      if (cls.kind === 'bare') continue;   // unknown vendor — skip
      // relative or tsconfig-path
      const resolved = await resolveLocal({
        specifier: spec,
        fromFile: abs,
        targetDir,
        tsconfigPaths,
      });
      if (resolved && !walked.has(resolved) && resolved.startsWith(targetDir + path.sep)) {
        queue.push(resolved);
      }
    }
  }

  // Sort by size desc (biggest-file-first per SPEC §6.1.3), then include all
  // up to MAX_TOTAL_BYTES. Since MAX_TOTAL_BYTES is generous, virtually no
  // real repo will truncate — but the cap prevents pathological cases from
  // eating the whole Haiku context window.
  const followedAbs = Array.from(walked).sort();
  const withSizes = await Promise.all(followedAbs.map(async (abs) => {
    const size = await tryFileSize(abs);
    return { abs, size };
  }));
  withSizes.sort((a, b) => b.size - a.size);

  const includedAbs: string[] = [];
  const parts: string[] = [];
  let totalBytes = 0;

  // Header for Haiku: which SDKs got imported anywhere in the walked graph.
  const sdkList = Array.from(sdkImports).sort();
  const header = sdkList.length
    ? `Detected SDK imports across walked files: ${sdkList.join(', ')}\n\n`
    : `Detected SDK imports across walked files: (none matched known SDKs)\n\n`;
  parts.push(header);
  totalBytes += header.length;

  for (const { abs } of withSizes) {
    const rel = path.relative(targetDir, abs);
    const src = await tryReadCapped(abs);
    if (src === null) continue;
    const block = `--- ${rel} ---\n${src}\n\n`;
    if (totalBytes + block.length > MAX_TOTAL_BYTES) {
      parts.push(`--- ${rel} ---\n[skipped: total bundle would exceed ${MAX_TOTAL_BYTES} bytes]\n\n`);
      continue;
    }
    parts.push(block);
    totalBytes += block.length;
    includedAbs.push(abs);
  }

  const followedFiles = includedAbs
    .map((abs) => path.relative(targetDir, abs))
    .sort();

  return {
    bundle: parts.join(''),
    followedFiles,
    sdkImports: sdkList,
    bundleBytes: totalBytes,
  };
}

async function tryReadCapped(abs: string): Promise<string | null> {
  try {
    const fh = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES_PER_FILE);
      const { bytesRead } = await fh.read(buf, 0, MAX_BYTES_PER_FILE, 0);
      return buf.slice(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function tryFileSize(abs: string): Promise<number> {
  try { const st = await fs.stat(abs); return st.size; }
  catch { return 0; }
}

// ---------- Import parsing ----------

// TS/JS: ES imports, dynamic imports, and CommonJS requires.
const RE_ES_IMPORT_FROM = /import\s+(?:type\s+)?[^;'"]*?\s+from\s+['"]([^'"]+)['"]/g;
const RE_ES_IMPORT_BARE = /import\s+['"]([^'"]+)['"]/g;
const RE_DYNAMIC_IMPORT = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_CJS_REQUIRE   = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// Python
const RE_PY_IMPORT     = /^\s*import\s+([a-zA-Z_][\w.]*)/gm;
const RE_PY_FROM       = /^\s*from\s+([a-zA-Z_.][\w.]*)\s+import/gm;

function extractImportSpecifiers(abs: string, src: string): string[] {
  const specs = new Set<string>();
  const push = (m: RegExpMatchArray) => { if (m[1]) specs.add(m[1]); };
  if (IS_TSJS(abs)) {
    for (const m of src.matchAll(RE_ES_IMPORT_FROM)) push(m);
    for (const m of src.matchAll(RE_ES_IMPORT_BARE)) push(m);
    for (const m of src.matchAll(RE_DYNAMIC_IMPORT)) push(m);
    for (const m of src.matchAll(RE_CJS_REQUIRE))   push(m);
  } else if (IS_PY(abs)) {
    for (const m of src.matchAll(RE_PY_IMPORT)) push(m);
    for (const m of src.matchAll(RE_PY_FROM))   push(m);
  }
  return Array.from(specs);
}

type SpecClass =
  | { kind: 'relative' }
  | { kind: 'absolute' }
  | { kind: 'tsconfig-path' }
  | { kind: 'sdk'; sdk: string }
  | { kind: 'bare' };

function classifySpecifier(spec: string, _targetDir: string): SpecClass {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return { kind: 'relative' };
  }
  if (spec.startsWith('/')) return { kind: 'absolute' };
  // Scoped: `@scope/name(/subpath)?`
  const isScoped = spec.startsWith('@');
  const parts = spec.split('/');
  const pkgName = isScoped ? parts.slice(0, 2).join('/') : parts[0];
  if (SDK_MAP[pkgName]) return { kind: 'sdk', sdk: SDK_MAP[pkgName].sdk };
  // Python dotted first-segment lookup
  const pyRoot = spec.split('.')[0];
  if (SDK_MAP[pyRoot]) return { kind: 'sdk', sdk: SDK_MAP[pyRoot].sdk };
  // Might be a tsconfig-path alias — checked by resolver.
  return { kind: 'bare' };
}

// ---------- Local resolution ----------

interface ResolveOpts {
  specifier: string;
  fromFile: string;
  targetDir: string;
  tsconfigPaths: TsconfigPaths;
}

async function resolveLocal(opts: ResolveOpts): Promise<string | null> {
  const { specifier, fromFile, targetDir, tsconfigPaths } = opts;
  const exts = IS_PY(fromFile) ? PY_EXTS : TSJS_EXTS;

  // Relative → resolve against fromFile's dir.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    return tryExtensionsAndIndex(base, exts);
  }
  // Absolute path (rare in TS/JS but possible in fixture-style paths)
  if (specifier.startsWith('/')) {
    return tryExtensionsAndIndex(specifier, exts);
  }
  // tsconfig-path alias — try each mapping.
  if (tsconfigPaths.length && IS_TSJS(fromFile)) {
    for (const { pattern, targets } of tsconfigPaths) {
      const matched = matchTsconfigPattern(pattern, specifier);
      if (matched === null) continue;
      for (const t of targets) {
        const substituted = t.replace('*', matched);
        const abs = path.resolve(targetDir, substituted);
        const hit = await tryExtensionsAndIndex(abs, exts);
        if (hit) return hit;
      }
    }
  }
  // Python: dotted intra-repo module (e.g. `mypkg.utils.llm`). Try to resolve
  // against targetDir as a candidate root.
  if (IS_PY(fromFile) && /^[a-zA-Z_]/.test(specifier)) {
    const parts = specifier.split('.');
    const candidate = path.resolve(targetDir, ...parts);
    const hit = await tryExtensionsAndIndex(candidate, exts);
    if (hit) return hit;
  }
  return null;
}

async function tryExtensionsAndIndex(base: string, exts: string[]): Promise<string | null> {
  // 1) base as-is if it has a recognized extension
  if (exts.some((e) => base.endsWith(e))) {
    if (await isFile(base)) return base;
  }
  // 2) base + ext
  for (const ext of exts) {
    const p = base + ext;
    if (await isFile(p)) return p;
  }
  // 3) base/index.<ext>
  for (const ext of exts) {
    const p = path.join(base, 'index' + ext);
    if (await isFile(p)) return p;
  }
  // 4) base/__init__.py for Python packages
  if (exts.includes('.py')) {
    const p = path.join(base, '__init__.py');
    if (await isFile(p)) return p;
  }
  return null;
}

async function isFile(abs: string): Promise<boolean> {
  try { const st = await fs.stat(abs); return st.isFile(); }
  catch { return false; }
}

// ---------- tsconfig paths ----------

interface TsconfigPathEntry { pattern: string; targets: string[] }
type TsconfigPaths = TsconfigPathEntry[];

async function readTsconfigPaths(targetDir: string): Promise<TsconfigPaths> {
  const tsconfigPath = path.join(targetDir, 'tsconfig.json');
  try {
    const raw = await fs.readFile(tsconfigPath, 'utf8');
    // Strip line and block comments so JSON.parse doesn't choke on JSONC.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);
    const json = JSON.parse(stripped);
    const co = json?.compilerOptions ?? {};
    const baseUrl = typeof co.baseUrl === 'string' ? co.baseUrl : '.';
    const paths = co.paths ?? {};
    const out: TsconfigPaths = [];
    for (const [pattern, arr] of Object.entries(paths)) {
      if (!Array.isArray(arr)) continue;
      const targets = (arr as unknown[])
        .filter((t): t is string => typeof t === 'string')
        .map((t) => path.join(baseUrl, t));
      out.push({ pattern, targets });
    }
    return out;
  } catch {
    return [];
  }
}

function matchTsconfigPattern(pattern: string, specifier: string): string | null {
  const starIx = pattern.indexOf('*');
  if (starIx === -1) return pattern === specifier ? '' : null;
  const prefix = pattern.slice(0, starIx);
  const suffix = pattern.slice(starIx + 1);
  if (!specifier.startsWith(prefix)) return null;
  if (suffix && !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

// ---------- Haiku call ----------

interface HaikuParsed {
  state: 'sdk-env' | 'sdk-config' | 'sdk-hardcoded' | 'no-sdk-detected';
  primarySdk?: string | null;
  otherSdks?: string[];
  evidence: string;
  hardcodedSites?: Array<{ file: string; line: number | null; literal: string; suggestedEnvVar: string }>;
}

async function callHaiku(
  orKey: string,
  bundle: string,
  sdkImports: string[],
): Promise<HaikuParsed> {
  const system = [
    'You classify how a codebase invokes LLMs based on the test files and their transitively-imported source files.',
    'Return ONLY valid JSON, no markdown fences, no prose.',
    'Schema:',
    '{',
    '  "state": "sdk-env" | "sdk-config" | "sdk-hardcoded" | "no-sdk-detected",',
    '  "primarySdk": string | null,',
    '  "otherSdks": string[],',
    '  "evidence": string (<= 400 chars, one paragraph),',
    '  "hardcodedSites": [{"file": string, "line": number | null, "literal": string, "suggestedEnvVar": string}]  // only when state=sdk-hardcoded',
    '}',
    '',
    'STATE meanings — pick exactly one:',
    '- sdk-env: a known SDK is imported (openai, @anthropic-ai/sdk, ai [Vercel], @ai-sdk/*, langchain, @langchain/*, @mastra/*, litellm, llamaindex, openrouter) AND the base URL either uses the SDK default (no override in code) OR reads process.env.<something>_BASE_URL directly. This is the good case — our proxy can intercept it by env swap.',
    '- sdk-config: a known SDK is imported AND base URL comes from a config value that ultimately traces back to an environment variable (e.g. `const cfg = { baseURL: process.env.LLM_URL }` then passed into the SDK). Still interceptable — env swap will work.',
    '- sdk-hardcoded: a known SDK is imported BUT base URL is a hardcoded string literal like `baseURL: "https://api.groq.com/openai/v1"`. Our proxy cannot intercept this. Populate hardcodedSites with the offending file, line (from your reading), the literal (truncate at 120 chars), and a suggested env-var name to swap it for.',
    '- no-sdk-detected: no recognized SDK is imported. The code uses raw fetch/httpx/requests, or an unknown/custom wrapper. Interception not guaranteed.',
    '',
    'Rules:',
    '- primarySdk: the most-imported / most-central SDK name (e.g. "@anthropic-ai/sdk", "openai", "ai", "langchain"). null when state=no-sdk-detected.',
    '- otherSdks: additional SDKs seen, alphabetized. Empty array is fine.',
    '- evidence: one paragraph. Cite specific import or code lines you observed.',
    '- Prefer sdk-env over sdk-config when in doubt; prefer sdk-config over sdk-hardcoded when in doubt.',
    '- The "Detected SDK imports" header at the top of the bundle is authoritative for whether an SDK is present.',
    '- If the SDK header lists any known SDK, the state MUST be one of sdk-env / sdk-config / sdk-hardcoded — never no-sdk-detected.',
  ].join('\n');

  const user = `Bundle follows. Analyze and classify.\n\n${bundle}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${orKey}`,
      'content-type': 'application/json',
      'x-title': 'canaryone/methodology',
    },
    body: JSON.stringify({
      model: METHODOLOGY_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user },
      ],
      max_tokens: 800,
      temperature: 0.1,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Haiku methodology call failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const body: any = await res.json();
  const text: string = body?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(text);
  if (!parsed || typeof parsed.state !== 'string') {
    throw new Error(`Bad JSON from Haiku: ${text.slice(0, 200)}`);
  }
  const state = parsed.state;
  if (!['sdk-env', 'sdk-config', 'sdk-hardcoded', 'no-sdk-detected'].includes(state)) {
    throw new Error(`Invalid state from Haiku: ${state}`);
  }
  // Post-hoc guard: if the deterministic bundle header saw a known SDK, don't
  // allow the model to answer no-sdk-detected. That would contradict evidence
  // we already have.
  const finalState = (state === 'no-sdk-detected' && sdkImports.length > 0)
    ? 'sdk-env'
    : state;

  const otherSdks = Array.isArray(parsed.otherSdks)
    ? parsed.otherSdks.filter((s: unknown) => typeof s === 'string').map((s: string) => s.slice(0, 60))
    : [];
  const hardcodedSites = finalState === 'sdk-hardcoded' && Array.isArray(parsed.hardcodedSites)
    ? parsed.hardcodedSites
        .filter((s: any) => s && typeof s.file === 'string' && typeof s.literal === 'string')
        .map((s: any) => ({
          file: String(s.file).slice(0, 200),
          line: typeof s.line === 'number' ? s.line : null,
          literal: String(s.literal).slice(0, 200),
          suggestedEnvVar: typeof s.suggestedEnvVar === 'string' ? s.suggestedEnvVar.slice(0, 60) : 'OPENAI_BASE_URL',
        }))
    : undefined;
  return {
    state: finalState as HaikuParsed['state'],
    primarySdk: typeof parsed.primarySdk === 'string' ? parsed.primarySdk : null,
    otherSdks,
    evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '',
    hardcodedSites,
  };
}

function extractJson(text: string): any | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

// ---------- Public helpers ----------

/** Return the well-known SDK seed list (used by the block screen).  */
export function knownSdkList(): string[] {
  return Array.from(new Set(Object.keys(SDK_MAP)));
}
