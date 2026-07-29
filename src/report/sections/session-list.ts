// §04 Session drilldown — collapsible per-session detail cards.
// Each session shows: outcome + judge reasoning + judge sub-scores +
// verify exit code + step count + cost + optional stdout tail.
//
// Header renames: "REP 0" → "attempt 1/N" for readability. "traj" → "judge".
// Body adds: task summary block (from tasks_meta / config.json) so viewers
// know what the test actually does, not just its file path.

import type { RunData, SessionRow, JudgeVerdict, TaskMetaRow } from '../data.js';
import { escapeHtml } from '../template.js';
import { fmtDollars, fmtDuration } from '../../lib/fmt.js';

export function renderSessionList(data: RunData): string {
  // Sort: winners (complete + high judge) first, then failures, then aborted.
  const sorted = [...data.sessions].sort((a, b) => {
    const statusOrder = (s: string) => s === 'complete' ? 0 : s === 'failed' ? 1 : 2;
    const so = statusOrder(a.status) - statusOrder(b.status);
    if (so !== 0) return so;
    const va = data.verdictBySession.get(a.id);
    const vb = data.verdictBySession.get(b.id);
    const ta = va?.trajectory_score ?? -1;
    const tb = vb?.trajectory_score ?? -1;
    return tb - ta;
  });

  // Repeats count per (task, lane) — used for "attempt X/N".
  const repeatsByKey = new Map<string, number>();
  for (const s of data.sessions) {
    const k = `${s.task_id}|${s.destination_slug}`;
    repeatsByKey.set(k, (repeatsByKey.get(k) ?? 0) + 1);
  }

  const tasksMetaById = new Map<string, TaskMetaRow>();
  for (const t of data.tasksMeta) tasksMetaById.set(t.task_id, t);

  const cards = sorted.map((s) => renderSession(s, data, repeatsByKey, tasksMetaById)).join('');

  return `
<section id="s4">
  <h2><span class="sec-num">04</span>Session drilldown</h2>
  <details class="explain">
    <summary>What each expanded session shows</summary>
    <div class="explain-body">
      <p>One collapsed card per session. Header carries a pass/fail glyph, the lane, task, attempt number (out of repeats), cost, and mini judge score. Expand to see the full judge verdict + reasoning, the four judge sub-scores (Action / Grounding / Verification / Efficiency, each 0-25), the verification exit code, and a tail of the child process's stdout.</p>
      <dl>
        <dt>Action</dt><dd>Computed from JSONL: fraction of turns that emitted or consumed a <code>tool_call</code>. Deterministic.</dd>
        <dt>Grounding</dt><dd>LLM-judged: does the final response cite specific data retrieved during the trajectory?</dd>
        <dt>Verification</dt><dd>LLM-judged: did the agent check its own work — re-read edits, invoke tests, self-audit?</dd>
        <dt>Efficiency</dt><dd>Computed from JSONL: <code>unique tool signatures / total tool calls</code>. Penalizes duplicate calls.</dd>
      </dl>
      <p style="margin-top: 10px;">Sessions are sorted with passing high-judge-score first; failures and aborts sink to the bottom.</p>
    </div>
  </details>
  <div class="session-list">${cards}</div>
</section>`;
}

function renderSession(
  s: SessionRow,
  data: RunData,
  repeatsByKey: Map<string, number>,
  tasksMetaById: Map<string, TaskMetaRow>,
): string {
  const v = data.verdictBySession.get(s.id) ?? {};
  const stepCount = (data.stepsBySession.get(s.id) ?? []).length;

  const outcome = v.outcome ?? (s.status === 'complete' ? 'success' : s.status === 'failed' ? 'failure' : 'uncertain');
  const glyph = outcome === 'success' ? '✓' : outcome === 'failure' ? '✗' : '?';
  const traj = v.trajectory_score;
  const trajWarn = traj != null && traj < 50;

  const durationMs = s.finished_at
    ? new Date(s.finished_at).getTime() - new Date(s.started_at).getTime()
    : 0;

  const totalRepeats = repeatsByKey.get(`${s.task_id}|${s.destination_slug}`) ?? 1;
  const attemptLabel = `attempt ${s.repeat_ix + 1}/${totalRepeats}`;

  const taskMeta = tasksMetaById.get(s.task_id);

  return `
    <details class="session" data-outcome="${escapeHtml(outcome)}">
      <summary>
        <span class="verdict-glyph">${escapeHtml(glyph)}</span>
        <span class="lane">${escapeHtml(s.destination_slug)}</span>
        <span class="task">${escapeHtml(s.task_id)}${s.task_file ? ` · ${escapeHtml(s.task_file)}` : ''}</span>
        <span class="repeat">${escapeHtml(attemptLabel)}</span>
        <span class="cost">${escapeHtml(fmtDollars(s.cost_usd ?? 0))}${traj != null ? ` · <span class="traj-mini${trajWarn ? ' warn' : ''}">judge ${traj}${trajWarn ? ' ⚠' : ''}</span>` : ''}</span>
      </summary>
      <div class="body">
        ${renderSessionBody(s, v, taskMeta, stepCount, durationMs)}
      </div>
    </details>`;
}

function renderSessionBody(
  s: SessionRow,
  v: JudgeVerdict,
  taskMeta: TaskMetaRow | undefined,
  stepCount: number,
  durationMs: number,
): string {
  const taskSummaryBlock = taskMeta?.summary ? `
    <div class="task-summary">
      <span class="task-summary-label">What this test does</span>
      <div class="task-summary-body">${escapeHtml(taskMeta.summary)}</div>
    </div>` : '';

  const subscoreRow = renderSubscores(v);
  const judgeReason = v.judge_reasoning ? `
    <div class="reason">
      <strong>Judge's reasoning on the outcome</strong>
      <div style="margin-top: 4px;">${escapeHtml(v.judge_reasoning)}</div>
    </div>` : '';
  const trajReason = v.trajectory_reasoning ? `
    <div class="reason" style="border-left-color: var(--marginal);">
      <strong>Judge's reasoning on the score</strong>
      <div style="margin-top: 4px;">${escapeHtml(v.trajectory_reasoning)}</div>
    </div>` : '';

  const stdoutTail = (s.verify_stdout_tail ?? '').trim();
  const stdoutBlock = stdoutTail
    ? `<h4 style="margin-top: 16px;">stdout tail</h4><div class="stdout-tail">${escapeHtml(stdoutTail.slice(-2000))}</div>`
    : '';

  const stderrTail = (s.verify_stderr_tail ?? '').trim();
  const stderrBlock = stderrTail
    ? `<h4 style="margin-top: 16px;">stderr tail</h4><div class="stdout-tail">${escapeHtml(stderrTail.slice(-2000))}</div>`
    : '';

  const modelRouter = `${escapeHtml(s.model_slug)} · <span class="router-badge ${escapeHtml(s.router)}">${escapeHtml((s.router || 'openrouter').toUpperCase())}</span>`;

  return `
    ${taskSummaryBlock}
    <dl class="session-body-grid">
      <dt>Session id</dt><dd><code>${escapeHtml(s.id)}</code></dd>
      <dt>Model / Rtr</dt><dd>${modelRouter}</dd>
      <dt>Verify exit</dt><dd><code>${s.verify_exit_code == null ? 'null' : escapeHtml(String(s.verify_exit_code))}</code>${s.failure_class ? ` <span class="muted">(${escapeHtml(s.failure_class)})</span>` : ''}</dd>
      <dt>Steps</dt><dd>${stepCount}</dd>
      <dt>Cost</dt><dd>${escapeHtml(fmtDollars(s.cost_usd ?? 0))}</dd>
      <dt>Duration</dt><dd>${durationMs > 0 ? fmtDuration(durationMs / 1000) : '—'}</dd>
      <dt>Outcome</dt><dd><strong>${escapeHtml(v.outcome ?? '—')}</strong>${v.confidence != null ? ` <span class="muted">(confidence ${v.confidence.toFixed(2)})</span>` : ''}</dd>
      <dt>Judge score</dt><dd>${v.trajectory_score != null ? `<strong>${v.trajectory_score}/100</strong>${v.trajectory_confidence != null ? ` <span class="muted">(confidence ${v.trajectory_confidence.toFixed(2)})</span>` : ''}` : '<span class="muted">no judge tags</span>'}</dd>
    </dl>
    ${subscoreRow}
    ${judgeReason}
    ${trajReason}
    ${stdoutBlock}
    ${stderrBlock}`;
}

function renderSubscores(v: JudgeVerdict): string {
  const scores = [
    { label: 'Action', val: v.action_score, computed: true },
    { label: 'Grounding', val: v.grounding_score, computed: false },
    { label: 'Verification', val: v.verification_score, computed: false },
    { label: 'Efficiency', val: v.efficiency_score, computed: true },
  ];
  if (scores.every((s) => s.val == null)) return '';
  const cards = scores.map((s) => `
    <div class="subscore${s.computed ? ' computed' : ''}">
      <div class="lbl">${escapeHtml(s.label)}${s.computed ? ' <span title="computed from JSONL">◆</span>' : ''}</div>
      <div class="val">${s.val != null ? escapeHtml(String(s.val)) : '—'}<span class="max">/25</span></div>
    </div>`).join('');
  return `<div class="subscore-row">${cards}</div>`;
}
