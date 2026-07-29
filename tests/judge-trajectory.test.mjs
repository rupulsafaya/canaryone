// Unit test for the trajectory summarizer's file-re-read collapse.
// Constructs synthetic JudgeStep objects (bypassing JSONL) so the test is
// deterministic and doesn't need OR to be reachable.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

async function main() {
  const canaryoneDir = new URL('..', import.meta.url).pathname;
  const traj = await import(pathToFileURL(path.join(canaryoneDir, 'src/judge/trajectory.ts')).href);

  const fileTxtV1 = `<path>foo.txt</path>\n<content>\n1: line-a\n2: line-b\n3: line-c\n</content>`;
  const fileTxtV2 = `<path>foo.txt</path>\n<content>\n1: line-a\n2: line-b-EDITED\n3: line-c\n4: line-d-new\n</content>`;

  // Three steps: step1 reads foo.txt, step2 re-reads foo.txt after edit,
  // step3 is empty tail (no tool result — just closes the sequence).
  const steps = [
    { step_ix: 0, request_messages: [{ role: 'user', content: 'read and edit foo.txt' }], response_text: 'I will read the file.', finish_reason: 'tool_calls', tool_calls: [] },
    { step_ix: 1, request_messages: [{ role: 'tool', content: fileTxtV1 }], response_text: 'Now editing.', finish_reason: 'tool_calls', tool_calls: [] },
    { step_ix: 2, request_messages: [{ role: 'tool', content: fileTxtV2 }], response_text: 'Edit landed. Done.', finish_reason: 'stop', tool_calls: [] },
  ];

  const summary = traj.summarizeTrajectory(steps);
  // Assertions:
  //  - first read should include the full <content> block (i.e. mention line-a/line-b/line-c raw)
  //  - re-read should NOT dump the full file again — it should emit a "diff vs step 1" marker
  //  - the diff should note the added/removed lines
  if (!summary.includes('line-a')) throw new Error('first read of foo.txt not emitted verbatim');
  if (!summary.includes('[re-read of foo.txt — diff vs step 1]')) {
    throw new Error(`re-read not collapsed into a diff marker. Summary:\n${summary}`);
  }
  if (!summary.includes('line-b-EDITED')) throw new Error('diff did not surface the edited line');
  if (!summary.includes('line-d-new')) throw new Error('diff did not surface the added line');
  if (!summary.includes('line-b')) throw new Error('diff did not surface the removed original line');
  // The second occurrence must NOT include the full <content> block again.
  const secondReadIdx = summary.indexOf('[re-read of foo.txt');
  const remainder = summary.slice(secondReadIdx);
  if (remainder.includes('<content>')) throw new Error('re-read still contains raw <content> — collapse did not run');

  // firstUserPrompt
  const first = traj.firstUserPrompt(steps);
  if (first !== 'read and edit foo.txt') throw new Error(`firstUserPrompt got: ${first}`);

  // buildTrajectoryContext
  const ctx = traj.buildTrajectoryContext(steps);
  if (ctx.finalResponse !== 'Edit landed. Done.') throw new Error(`finalResponse got: ${ctx.finalResponse}`);
  if (ctx.lastFinishReason !== 'stop') throw new Error(`lastFinishReason got: ${ctx.lastFinishReason}`);

  // ---------- subscores ----------
  const sub = await import(pathToFileURL(path.join(canaryoneDir, 'src/judge/subscores.ts')).href);

  // Single-turn: score 25 by default.
  const single = sub.computeActionScore([steps[0]]);
  if (single.score !== 25) throw new Error(`single-turn action expected 25, got ${single.score}`);

  // 3 turns, tool_result appears in step 2 + step 3 → 2/3 turns have a tool_call.
  // Also step1 has finish_reason='tool_calls' — that also counts. So 2 turns qualify:
  //   step0: finish=tool_calls OR next has tool → yes
  //   step1: finish=tool_calls OR next has tool → yes
  //   step2: finish=stop, no next → no
  // withTool=2, total=3, score = floor(25*2/3) = 16
  const action = sub.computeActionScore(steps);
  if (action.score !== 16) throw new Error(`3-turn action expected 16, got ${action.score}`);

  // No tool_calls in the response bodies of the fixture → efficiency default 25.
  const eff = sub.computeEfficiencyScore(steps);
  if (eff.score !== 25) throw new Error(`no-tool-calls efficiency expected 25, got ${eff.score}`);

  // Duplicate signature test:
  const dupSteps = [
    { step_ix: 0, request_messages: [], response_text: '', finish_reason: 'tool_calls', tool_calls: [
      { function: { name: 'read', arguments: '{"path":"foo.txt"}' } },
      { function: { name: 'read', arguments: '{"path":"foo.txt"}' } },   // dup
      { function: { name: 'read', arguments: '{"path":"bar.txt"}' } },
    ] },
  ];
  const dup = sub.computeEfficiencyScore(dupSteps);
  // 2 unique of 3 → floor(25*2/3) = 16
  if (dup.score !== 16) throw new Error(`dup-tool-call efficiency expected 16, got ${dup.score}`);

  console.log('[judge-trajectory] PASS · trajectory + subscores green');
}

main().catch((e) => {
  console.error('[judge-trajectory] FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
