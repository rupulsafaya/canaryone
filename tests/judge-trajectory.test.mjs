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

  console.log('[judge-trajectory] PASS · file-re-read collapse + prompt extraction green');
}

main().catch((e) => {
  console.error('[judge-trajectory] FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
