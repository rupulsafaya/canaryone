// Computed sub-scores — the deterministic half of the trajectory composite.
// No LLM. Reads the parsed JudgeStep[] and returns {score:0-25, evidence:string}.
//
// Action    = turns_with_tool_call / total_turns   (single-turn workloads → 25)
// Efficiency = unique_tool_signatures / total_tool_calls  (both zero → 25)

import type { JudgeStep, ChatMessage } from './trajectory.js';

export interface SubScore {
  score: number;   // 0..25
  evidence: string;
}

// A step counts as a "turn with tool_call" if either:
//   (a) its response emitted tool_calls (finish_reason='tool_calls' or msg.tool_calls[])
//   (b) the NEXT step's request contains role=tool messages (client sent results back)
export function computeActionScore(steps: JudgeStep[]): SubScore {
  const total = steps.length;
  if (total <= 1) {
    return {
      score: 25,
      evidence: `single-turn workload (steps=${total}) — no tool grounding required, default 25`,
    };
  }
  let withTool = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const emittedToolCall = (s.tool_calls?.length ?? 0) > 0 || s.finish_reason === 'tool_calls';
    const nextHasToolResult = i + 1 < steps.length
      && steps[i + 1].request_messages.some((m: ChatMessage) => m.role === 'tool');
    if (emittedToolCall || nextHasToolResult) withTool++;
  }
  const score = Math.min(25, Math.floor(25 * (withTool / total)));
  return {
    score,
    evidence: `${withTool}/${total} turns emitted or consumed a tool_call`,
  };
}

// Efficiency: unique_tool_signatures / total_tool_calls.
// signature = tool_name + canonicalized args JSON.
export function computeEfficiencyScore(steps: JudgeStep[]): SubScore {
  const signatures: string[] = [];
  for (const step of steps) {
    for (const call of step.tool_calls ?? []) {
      const sig = signatureOf(call);
      if (sig) signatures.push(sig);
    }
  }
  const total = signatures.length;
  if (total === 0) {
    return {
      score: 25,
      evidence: 'no tool_calls observed — vacuously efficient (default 25)',
    };
  }
  const unique = new Set(signatures).size;
  const score = Math.min(25, Math.floor(25 * (unique / total)));
  return {
    score,
    evidence: `${unique}/${total} tool_call signatures unique`,
  };
}

function signatureOf(call: unknown): string | null {
  if (!call || typeof call !== 'object') return null;
  const fn = (call as { function?: { name?: string; arguments?: unknown } }).function;
  if (!fn?.name) return null;
  const rawArgs = fn.arguments;
  let canonical: string;
  if (typeof rawArgs === 'string') {
    try { canonical = canonicalize(JSON.parse(rawArgs)); }
    catch { canonical = rawArgs; }   // not JSON — treat as opaque string
  } else if (rawArgs && typeof rawArgs === 'object') {
    canonical = canonicalize(rawArgs);
  } else {
    canonical = '';
  }
  return `${fn.name}::${canonical}`;
}

// Canonicalize object keys so semantically-equal arg blobs collapse to one
// signature regardless of key ordering.
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}
