// judgeSession — the Haiku-r5 call.
// Assembles trajectory + computed sub-scores + git_diff + verify exit code,
// posts to OpenRouter with anthropic/claude-haiku-4.5, parses the verdict,
// combines LLM-judged + computed sub-scores into the composite trajectory_score.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTrajectoryContext,
  loadSteps,
  summarizeTrajectory,
  MAX_CONTENT_CHARS,
  type JudgeStep,
} from './trajectory.js';
import { computeActionScore, computeEfficiencyScore, type SubScore } from './subscores.js';
import { type GitDiffSummary } from './git-diff.js';
import type { ClassifierTagInsert, ClassifierMeta } from '../db/sqlite.js';

export const JUDGE_MODEL = 'anthropic/claude-haiku-4.5';
export const JUDGE_MAX_TOKENS = 400;
export const CLASSIFIER_ID = 'canaryone_judge_v1_local';
export const CLASSIFIER_VERSION = '2026-07-29-haiku-r5-local';

export interface Verdict {
  outcome: 'success' | 'failure' | 'uncertain';
  confidence: number;
  reasoning: string;

  trajectory_score: number;        // 0..100
  trajectory_confidence: number;   // 0..1
  action: number;                  // computed, 0..25
  grounding: number;               // LLM, 0..25
  verification: number;            // LLM, 0..25
  efficiency: number;              // computed, 0..25
  trajectory_reasoning: string;

  action_evidence: string;
  efficiency_evidence: string;
  judge_ok: boolean;               // false when LLM call failed and we fell back
  error?: string;                  // populated when judge_ok=false
}

export interface JudgeContext {
  jsonlPath: string;
  gitDiff: GitDiffSummary;      // captured pre-cleanup by the orchestrator
  orKey: string;
  verifyExitCode: number | null;
  testFile: string;
  taskId: string;
}

// Load the prompt file at module import time — no filesystem work per call.
const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompt-haiku-r5-local.md');
export const JUDGE_SYSTEM = fs.readFileSync(PROMPT_PATH, 'utf8');

export async function judgeSession(sessionId: string, ctx: JudgeContext): Promise<Verdict> {
  const steps = await loadSteps(ctx.jsonlPath, sessionId);
  const traj = buildTrajectoryContext(steps);
  const action = computeActionScore(steps);
  const efficiency = computeEfficiencyScore(steps);
  try {
    const llm = await callHaiku(traj, steps, action, efficiency, ctx.gitDiff, ctx);
    return composeVerdict(action, efficiency, llm, ctx.verifyExitCode);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return fallbackVerdict(action, efficiency, ctx.verifyExitCode, err);
  }
}

// Combine computed + LLM sub-scores into a single verdict. verification_exit_code
// is the ground truth for outcome: if the customer's test passed, we return
// 'success' regardless of what the LLM said. LLM's outcome is only consulted
// when the exit code is null.
function composeVerdict(
  action: SubScore,
  efficiency: SubScore,
  llm: LlmVerdictParsed,
  verifyExitCode: number | null,
): Verdict {
  let outcome: Verdict['outcome'];
  let confidence: number;
  if (verifyExitCode === 0) {
    outcome = 'success';
    confidence = clamp01(Math.max(0.85, llm.confidence));   // exit-code passing is strong evidence
  } else if (typeof verifyExitCode === 'number' && verifyExitCode !== 0) {
    outcome = 'failure';
    confidence = clamp01(Math.max(0.85, llm.confidence));
  } else {
    outcome = llm.outcome;
    confidence = clamp01(Math.min(0.85, llm.confidence));   // no exit signal → cap
  }

  const grounding = clamp25(llm.grounding);
  const verification = clamp25(llm.verification);
  const trajectory_score = action.score + grounding + verification + efficiency.score;

  return {
    outcome,
    confidence,
    reasoning: llm.reasoning || '(no reasoning provided)',
    trajectory_score,
    trajectory_confidence: clamp01(llm.trajectory_confidence),
    action: action.score,
    grounding,
    verification,
    efficiency: efficiency.score,
    trajectory_reasoning: llm.trajectory_reasoning || '(no trajectory reasoning provided)',
    action_evidence: action.evidence,
    efficiency_evidence: efficiency.evidence,
    judge_ok: true,
  };
}

// When the LLM call errors, write outcome from exit code alone.
// trajectory_score = action + efficiency (only the computed halves) so the
// row is still auditable — but the LLM-judged halves are zero and
// trajectory_confidence = 0 to flag that the pass wasn't complete.
export function fallbackVerdict(
  action: SubScore,
  efficiency: SubScore,
  verifyExitCode: number | null,
  errorMessage: string,
): Verdict {
  const outcome: Verdict['outcome'] =
    verifyExitCode === 0 ? 'success'
      : typeof verifyExitCode === 'number' ? 'failure'
        : 'uncertain';
  return {
    outcome,
    confidence: verifyExitCode !== null ? 0.85 : 0.3,
    reasoning: `judge unavailable — fell back to verification exit code (${verifyExitCode ?? 'null'})`,
    trajectory_score: 0,   // per Q&A #3: unknown quality, not composite of computed halves
    trajectory_confidence: 0,
    action: action.score,
    grounding: 0,
    verification: 0,
    efficiency: efficiency.score,
    trajectory_reasoning: `judge call failed: ${errorMessage.slice(0, 200)}`,
    action_evidence: action.evidence,
    efficiency_evidence: efficiency.evidence,
    judge_ok: false,
    error: errorMessage.slice(0, 500),
  };
}

// ---------- LLM plumbing ----------

interface LlmVerdictParsed {
  outcome: 'success' | 'failure' | 'uncertain';
  confidence: number;
  reasoning: string;
  grounding: number;
  verification: number;
  trajectory_confidence: number;
  trajectory_reasoning: string;
}

async function callHaiku(
  traj: ReturnType<typeof buildTrajectoryContext>,
  _steps: JudgeStep[],
  action: SubScore,
  efficiency: SubScore,
  gitDiff: GitDiffSummary,
  ctx: JudgeContext,
): Promise<LlmVerdictParsed> {
  const trajectory = summarizeTrajectory(traj.steps);
  const finalOut = traj.finalResponse || '(empty)';
  const lastFinish = traj.lastFinishReason ?? 'unknown';

  const gitBlock = gitDiff.is_git
    ? `files_changed: ${gitDiff.files_changed}, insertions: ${gitDiff.insertions}, deletions: ${gitDiff.deletions}\npaths: ${gitDiff.paths.length ? gitDiff.paths.join(', ') : '(none)'}`
    : '(worktree is not a git repository — file diff signal unavailable)';

  const userInput = [
    `=== Task ===`,
    `Task ID: ${ctx.taskId}`,
    `Test file: ${ctx.testFile}`,
    `User request (first prompt): ${traj.firstUserPrompt}`,
    ``,
    `Steps: ${traj.steps.length}`,
    `last_step_finish_reason: ${lastFinish}`,
    `verification_exit_code: ${ctx.verifyExitCode ?? 'null'}`,
    ``,
    `--- computed_subscores ---`,
    `action: ${action.score}/25  (${action.evidence})`,
    `efficiency: ${efficiency.score}/25  (${efficiency.evidence})`,
    ``,
    `--- git_diff_summary ---`,
    gitBlock,
    ``,
    `--- Trajectory ---`,
    trajectory,
    ``,
    `--- Final assistant response ---`,
    finalOut.slice(0, MAX_CONTENT_CHARS),
  ].join('\n');

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: userInput },
  ];

  const first = await callOnce(messages, ctx.orKey);
  try {
    return parseJudgeContent(first);
  } catch {
    messages.push({ role: 'assistant', content: first });
    messages.push({
      role: 'user',
      content:
        'That response was not valid JSON. Reply with ONLY the JSON object matching the schema ' +
        '{"outcome": "success"|"failure"|"uncertain", "confidence": <0.0-1.0>, "reasoning": "<one sentence>", ' +
        '"grounding": <0-25>, "verification": <0-25>, "trajectory_confidence": <0.0-1.0>, ' +
        '"trajectory_reasoning": "<one sentence>"} — no markdown, no prose, no leading or trailing text.',
    });
    const second = await callOnce(messages, ctx.orKey);
    return parseJudgeContent(second);
  }
}

async function callOnce(messages: Array<{ role: string; content: string }>, apiKey: string): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Title': 'canaryone-judge',
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: JUDGE_MAX_TOKENS,
      temperature: 0,
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`judge HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('judge returned empty content');
  return content;
}

export function parseJudgeContent(content: string): LlmVerdictParsed {
  let cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!cleaned.startsWith('{')) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) cleaned = m[0];
  }
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const outcomeRaw = String(parsed.outcome ?? 'uncertain').toLowerCase();
  const outcome = (['success', 'failure', 'uncertain'] as const)
    .find((v) => v === outcomeRaw) ?? 'uncertain';
  return {
    outcome,
    confidence: numOr(parsed.confidence, 0.5),
    reasoning: String(parsed.reasoning ?? '').slice(0, 500),
    grounding: numOr(parsed.grounding, 0),
    verification: numOr(parsed.verification, 0),
    trajectory_confidence: numOr(parsed.trajectory_confidence, 0.5),
    trajectory_reasoning: String(parsed.trajectory_reasoning ?? '').slice(0, 500),
  };
}

export const JUDGE_CLASSIFIER_META: ClassifierMeta = {
  model: JUDGE_MODEL,
  classifierId: CLASSIFIER_ID,
  classifierVersion: CLASSIFIER_VERSION,
};

// Flatten a Verdict into the ClassifierTagInsert[] shape expected by
// Db.insertClassifierTags. One row per dimension.
export function verdictToTags(v: Verdict): ClassifierTagInsert[] {
  return [
    { dimension: 'outcome', value: v.outcome, confidence: v.confidence },
    { dimension: 'trajectory_score', value: String(v.trajectory_score), confidence: v.trajectory_confidence },
    { dimension: 'action_score', value: String(v.action), confidence: 1 },
    { dimension: 'grounding_score', value: String(v.grounding), confidence: v.trajectory_confidence },
    { dimension: 'verification_score', value: String(v.verification), confidence: v.trajectory_confidence },
    { dimension: 'efficiency_score', value: String(v.efficiency), confidence: 1 },
    { dimension: 'judge_reasoning', value: v.reasoning, confidence: v.confidence },
    { dimension: 'trajectory_reasoning', value: v.trajectory_reasoning, confidence: v.trajectory_confidence },
  ];
}

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : fallback;
}
function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }
function clamp25(v: number): number { return Math.max(0, Math.min(25, Math.round(v))); }
