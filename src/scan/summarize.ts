import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../data/schema.js';
import type { MatchedFile } from './glob.js';
import { detectOrKey } from './orchestrator.js';

export const SUMMARY_MODEL = 'anthropic/claude-haiku-4.5';
const MAX_BYTES_PER_FILE = 4096;
const PARALLELISM = 3;

export interface Summary {
  summary: string;
  bullets: string[];
  usesLLM?: boolean;
  llmEvidence?: string;
  mtimeMs: number;
  generatedAt: string;
  model: string;
}

export type SummariesMap = NonNullable<Config['tasks']['summaries']>;

export interface SummarizeItemResult {
  file: string;             // relative path
  ok: boolean;
  summary?: Summary;
  error?: string;
}

export interface SummarizeProgress {
  file: string;             // relative
  index: number;
  total: number;
  status: 'reading' | 'calling' | 'done' | 'error' | 'cached';
  error?: string;
}

export interface SummarizeOpts {
  files: MatchedFile[];
  targetDir: string;
  existing?: SummariesMap;
  onProgress?: (p: SummarizeProgress) => void;
}

/**
 * Batched Haiku 4.5 summaries for each matched test file.
 * Uses OR /api/v1/chat/completions. Skips files whose cached summary is
 * newer than the file's mtime.
 */
export async function summarizeTests(opts: SummarizeOpts): Promise<{
  summaries: SummariesMap;
  results: SummarizeItemResult[];
}> {
  const { files, targetDir, existing = {}, onProgress } = opts;

  const detected = await detectOrKey();
  if (!detected.value) {
    throw new Error('No OpenRouter key available — cannot summarize.');
  }
  const orKey = detected.value;

  const summaries: SummariesMap = { ...existing };
  const results: SummarizeItemResult[] = [];

  // Determine which files need (re)summarization.
  const toProcess: { file: MatchedFile; mtimeMs: number; index: number }[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let mtimeMs = 0;
    try { const st = await fs.stat(f.absolute); mtimeMs = st.mtimeMs; } catch { /* ignore */ }
    const cached = existing[f.relative];
    // Invalidate when file mtime changed OR when cache predates the usesLLM
    // classification field (older schema — needs re-read to populate).
    const cacheFresh = cached && cached.mtimeMs === mtimeMs && typeof cached.usesLLM === 'boolean';
    if (cacheFresh) {
      results.push({ file: f.relative, ok: true, summary: cached });
      onProgress?.({ file: f.relative, index: i, total: files.length, status: 'cached' });
      continue;
    }
    toProcess.push({ file: f, mtimeMs, index: i });
  }

  let cursor = 0;
  async function worker() {
    while (cursor < toProcess.length) {
      const idx = cursor++;
      const { file, mtimeMs, index } = toProcess[idx];
      onProgress?.({ file: file.relative, index, total: files.length, status: 'reading' });
      let content: string;
      try {
        content = await readCapped(file.absolute, MAX_BYTES_PER_FILE);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        results.push({ file: file.relative, ok: false, error: `read: ${err}` });
        onProgress?.({ file: file.relative, index, total: files.length, status: 'error', error: err });
        continue;
      }
      onProgress?.({ file: file.relative, index, total: files.length, status: 'calling' });
      try {
        const parsed = await callHaikuJson(orKey, file.relative, content);
        const summary: Summary = {
          summary: parsed.summary,
          bullets: parsed.bullets,
          usesLLM: parsed.usesLLM,
          llmEvidence: parsed.llmEvidence,
          mtimeMs,
          generatedAt: new Date().toISOString(),
          model: SUMMARY_MODEL,
        };
        summaries[file.relative] = summary;
        results.push({ file: file.relative, ok: true, summary });
        onProgress?.({ file: file.relative, index, total: files.length, status: 'done' });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        results.push({ file: file.relative, ok: false, error: err });
        onProgress?.({ file: file.relative, index, total: files.length, status: 'error', error: err });
      }
    }
  }
  const workers = Array.from({ length: Math.min(PARALLELISM, toProcess.length) }, () => worker());
  await Promise.all(workers);

  return { summaries, results };
}

async function readCapped(absPath: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function callHaikuJson(
  orKey: string,
  relPath: string,
  content: string,
): Promise<{ summary: string; bullets: string[]; usesLLM?: boolean; llmEvidence?: string }> {
  const system = [
    'You analyze a test file and return a compact JSON description.',
    'Return ONLY valid JSON, no markdown fences, no prose before or after.',
    'Schema: { "summary": string, "bullets": string[], "usesLLM": boolean, "llmEvidence": string }',
    'summary: one sentence, <= 100 chars, what this test verifies functionally.',
    'bullets: 3-5 items, each <= 90 chars, describing what specifically is exercised.',
    'usesLLM: true iff the code under test (not the test harness itself) makes an LLM/agent API call — Anthropic, OpenAI, OpenRouter, Bedrock, Vertex, langchain, mastra, ollama, or a local model. False for deterministic unit/lint/e2e tests that never invoke an LLM. When ambiguous, prefer false.',
    'llmEvidence: <=80 chars, one concrete signal you saw (e.g. "imports @anthropic-ai/sdk" or "calls judgeJob() which uses claude-haiku"). Empty string if usesLLM is false.',
    'Prefer verbs in bullets. Skip imports and boilerplate. Do not restate the filename.',
  ].join(' ');

  const user = `File: ${relPath}\n\n${content}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${orKey}`,
      'content-type': 'application/json',
      'x-title': 'canaryone/summarize',
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 400,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const body: any = await res.json();
  const text: string = body?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(text);
  if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.bullets)) {
    throw new Error(`bad JSON from model: ${text.slice(0, 200)}`);
  }
  const usesLLM = typeof parsed.usesLLM === 'boolean' ? parsed.usesLLM : undefined;
  const llmEvidence = typeof parsed.llmEvidence === 'string' && parsed.llmEvidence.length > 0
    ? String(parsed.llmEvidence).slice(0, 160)
    : undefined;
  return {
    summary: String(parsed.summary).slice(0, 200),
    bullets: parsed.bullets.map((b: unknown) => String(b).slice(0, 200)).slice(0, 6),
    usesLLM,
    llmEvidence,
  };
}

function extractJson(text: string): any | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // Fallback: grab the outermost {...}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

export function areAllCached(files: MatchedFile[], summaries: SummariesMap | undefined, mtimes: Record<string, number>): boolean {
  if (!summaries) return false;
  return files.every((f) => {
    const s = summaries[f.relative];
    return s && s.mtimeMs === mtimes[f.relative];
  });
}

export async function collectMtimes(files: MatchedFile[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(files.map(async (f) => {
    try { const st = await fs.stat(f.absolute); out[f.relative] = st.mtimeMs; }
    catch { out[f.relative] = 0; }
  }));
  return out;
}
