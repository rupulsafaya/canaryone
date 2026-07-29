// Trajectory summarizer for the local judge.
//
// Ported from ~/Documents/GitHub/canaryone-cloud/scripts/judge_v1.ts
// (lines 25–401). The core reusable logic is:
//   - Walk request/response pairs in step order
//   - For each step: emit `[step N] assistant: <text>` + `[step N] tool_result: <text>`
//   - Collapse re-reads of the same file into a compact diff (compactFileDiff)
//
// Adaptation: source read from OTLP spans; we read the local traffic.jsonl.
// Same output shape — one string suitable for feeding to the judge prompt.

import { iterRecords, type TrafficRecord } from '../runner/traffic-log.js';

// Budget constants — mirror source.
export const MAX_CONTENT_CHARS = 3000;
export const MAX_TOOL_RESULT_CHARS = 4000;
export const MAX_DIFF_CHARS = 2500;
export const MAX_TRAJECTORY_CHARS = 40_000;

export interface ChatMessage {
  role: string;
  content?: string | Array<{ type?: string; text?: string; tool_calls?: unknown }>;
  tool_calls?: unknown;
}

export interface JudgeStep {
  step_ix: number;
  request_messages: ChatMessage[];
  response_text: string;
  finish_reason: string | null;
  tool_calls: unknown[];   // from response.body.choices[0].message.tool_calls
}

export interface TrajectoryContext {
  steps: JudgeStep[];
  firstUserPrompt: string;
  finalResponse: string;
  lastFinishReason: string | null;
}

// Extract steps for a session by walking the traffic JSONL. Pairs request +
// response by step_id. Returns steps in step_ix order.
export async function loadSteps(jsonlPath: string, sessionId: string): Promise<JudgeStep[]> {
  const requests = new Map<string, TrafficRecord>();
  const responses = new Map<string, TrafficRecord>();

  for await (const rec of iterRecords(jsonlPath)) {
    if (rec.session_id !== sessionId) continue;
    if (rec.kind === 'request' && rec.step_id) requests.set(rec.step_id, rec);
    else if (rec.kind === 'response' && rec.step_id) responses.set(rec.step_id, rec);
  }

  const steps: JudgeStep[] = [];
  for (const [stepId, req] of requests) {
    const resp = responses.get(stepId);
    const reqBody = (req.body ?? {}) as Record<string, unknown>;
    const respBody = (resp?.body ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(reqBody.messages) ? (reqBody.messages as ChatMessage[]) : [];
    const choices = Array.isArray(respBody.choices) ? (respBody.choices as Array<Record<string, unknown>>) : [];
    const msg = (choices[0]?.message ?? {}) as Record<string, unknown>;
    const responseText = typeof msg.content === 'string' ? msg.content : '';
    const finishReason = typeof choices[0]?.finish_reason === 'string'
      ? (choices[0].finish_reason as string) : null;
    const toolCalls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as unknown[]) : [];
    steps.push({
      step_ix: req.step_ix ?? 0,
      request_messages: messages,
      response_text: responseText,
      finish_reason: finishReason,
      tool_calls: toolCalls,
    });
  }
  steps.sort((a, b) => a.step_ix - b.step_ix);
  return steps;
}

export function messageToText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && 'text' in p) return String(p.text ?? '');
        return '';
      })
      .join(' ');
  }
  return '';
}

export function firstUserPrompt(steps: JudgeStep[]): string {
  const first = steps[0];
  if (!first) return '(no user message found)';
  const messages = first.request_messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messageToText(messages[i]).slice(0, MAX_CONTENT_CHARS);
    }
  }
  return '(no user message found)';
}

// Extract file path from an opencode-style `<path>...</path>` tool_result.
export function extractFilePath(toolResultText: string): string | null {
  const m = toolResultText.match(/<path>([^<]+)<\/path>/);
  return m ? m[1].trim() : null;
}

// Extract the numbered content block from an opencode file-read tool_result.
export function extractFileContentLines(toolResultText: string): string[] | null {
  const m = toolResultText.match(/<content>\n?([\s\S]*?)<\/content>/);
  if (!m) return null;
  return m[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\d+:\s?/, ''))
    .filter((line, i, arr) => !(i === arr.length - 1 && line === ''));
}

// Line-level diff summary between two versions of the same file — catches
// added / removed lines. Missed reorderings on purpose (cheaper, sufficient
// for "did the edit land").
export function compactFileDiff(older: string[], newer: string[]): string {
  const olderSet = new Set(older.map((s) => s.trim()));
  const newerSet = new Set(newer.map((s) => s.trim()));
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of newer) {
    const norm = line.trim();
    if (norm && !olderSet.has(norm)) added.push(line);
  }
  for (const line of older) {
    const norm = line.trim();
    if (norm && !newerSet.has(norm)) removed.push(line);
  }
  if (added.length === 0 && removed.length === 0) {
    return '(no line-level changes vs prior read)';
  }
  const out: string[] = [];
  out.push(`+${added.length} lines added, -${removed.length} lines removed:`);
  for (const line of removed.slice(0, 20)) out.push(`  - ${line.slice(0, 200)}`);
  for (const line of added.slice(0, 20)) out.push(`  + ${line.slice(0, 200)}`);
  if (added.length > 20 || removed.length > 20) out.push(`  (…more changes omitted)`);
  return out.join('\n').slice(0, MAX_DIFF_CHARS);
}

// Walk steps in order, emit assistant text + tool_result blocks. Collapse
// re-reads of the same file into a compact diff.
export function summarizeTrajectory(steps: JudgeStep[]): string {
  const parts: string[] = [];
  let budget = MAX_TRAJECTORY_CHARS;
  const firstReadByPath = new Map<string, { step: number; lines: string[] }>();

  for (let i = 0; i < steps.length; i++) {
    const t = steps[i];
    const out = t.response_text.slice(0, MAX_CONTENT_CHARS);
    if (out.length && budget > 0) {
      const line = `[step ${i + 1}] assistant: ${out.slice(0, budget)}`;
      parts.push(line);
      budget -= line.length;
    }

    // Tool results appear in the NEXT step's request messages array as role=tool.
    if (i + 1 < steps.length && budget > 0) {
      const nextMsgs = steps[i + 1].request_messages;
      const toolResults = nextMsgs.filter((m) => m.role === 'tool');
      for (const tr of toolResults) {
        const fullTxt = messageToText(tr);
        if (!fullTxt) continue;

        const filePath = extractFilePath(fullTxt);
        const isFileRead = filePath !== null;
        let renderedText: string;

        if (isFileRead && firstReadByPath.has(filePath)) {
          const prior = firstReadByPath.get(filePath)!;
          const currentLines = extractFileContentLines(fullTxt) ?? [];
          const diff = compactFileDiff(prior.lines, currentLines);
          renderedText = `[re-read of ${filePath} — diff vs step ${prior.step}]\n${diff}`;
        } else {
          renderedText = fullTxt.slice(0, MAX_TOOL_RESULT_CHARS);
          if (isFileRead) {
            const lines = extractFileContentLines(fullTxt);
            if (lines) firstReadByPath.set(filePath, { step: i + 1, lines });
          }
        }

        const line = `[step ${i + 1}] tool_result: ${renderedText.slice(0, budget)}`;
        parts.push(line);
        budget -= line.length;
        if (budget <= 0) break;
      }
    }
    if (budget <= 0) break;
  }

  return parts.join('\n') || '(no assistant output captured)';
}

export function buildTrajectoryContext(steps: JudgeStep[]): TrajectoryContext {
  const last = steps[steps.length - 1];
  return {
    steps,
    firstUserPrompt: firstUserPrompt(steps),
    finalResponse: last?.response_text.slice(0, MAX_CONTENT_CHARS) ?? '',
    lastFinishReason: last?.finish_reason ?? null,
  };
}
