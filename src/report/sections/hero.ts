// Hero section — metadata block + "how we measure" primer.

import type { RunData } from '../data.js';
import { escapeHtml } from '../template.js';
import { fmtDollars, fmtDuration } from '../../lib/fmt.js';

export function renderHero(data: RunData): string {
  const { run, meta, sessions } = data;

  const startedAt = run.started_at;
  const finishedAt = run.finished_at ?? '(in progress)';
  const durationSec = finishedAt !== '(in progress)'
    ? (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000
    : 0;

  const passed = sessions.filter((s) => s.status === 'complete').length;
  const failed = sessions.filter((s) => s.status === 'failed').length;
  const aborted = sessions.filter((s) => s.status === 'aborted').length;
  const totalSpend = sessions.reduce((a, s) => a + (s.cost_usd ?? 0), 0);

  const lanes = new Set(sessions.map((s) => `${s.model_slug}@${s.destination_slug}`));
  const models = new Set(sessions.map((s) => s.model_slug));
  const tasks = new Set(sessions.map((s) => s.task_id));
  const repeats = meta?.repeats ?? Math.max(...Array.from(
    sessions.reduce((m, s) => {
      const k = `${s.task_id}|${s.destination_slug}`;
      m.set(k, (m.get(k) ?? 0) + 1);
      return m;
    }, new Map<string, number>()).values()
  ), 1);

  const passRatePct = sessions.length > 0 ? Math.round((passed / sessions.length) * 100) : 0;

  const targetDir = escapeHtml(run.target_dir);
  const modelList = escapeHtml([...models].join(', '));

  return `
<section id="hero">
  <h1>canaryone · Run report</h1>
  <div class="hero-sub">
    Run <code>${escapeHtml(run.id)}</code>
    · ${escapeHtml(startedAt)}
    · ${finishedAt !== '(in progress)' ? fmtDuration(durationSec) + ' wall-clock' : escapeHtml(finishedAt)}
  </div>

  <table class="meta-table">
    <tr><td class="label">Target</td><td><code>${targetDir}</code></td></tr>
    <tr><td class="label">Model(s)</td><td><code>${modelList}</code></td></tr>
    <tr><td class="label">Lanes</td><td>${lanes.size} (${[...lanes].map((l) => `<code>${escapeHtml(l)}</code>`).join(', ')})</td></tr>
    <tr><td class="label">Sessions</td><td>${sessions.length} <span class="muted">= ${tasks.size} task${tasks.size === 1 ? '' : 's'} × ${lanes.size} lane${lanes.size === 1 ? '' : 's'} × ${repeats} repeat${repeats === 1 ? '' : 's'}</span></td></tr>
    <tr><td class="label">Pass rate</td><td><strong>${passed}/${sessions.length}</strong> <span class="muted">(${passRatePct}%)</span>${failed > 0 ? ` <span class="muted"> · ${failed} failed</span>` : ''}${aborted > 0 ? ` <span class="muted"> · ${aborted} aborted</span>` : ''}</td></tr>
    <tr><td class="label">Total spend</td><td><strong>${fmtDollars(totalSpend)}</strong></td></tr>
  </table>

  <details open class="metric-primer" style="display: block; padding: 0;">
    <summary style="cursor: pointer; padding: 14px 18px; font-weight: 600; list-style: none; outline: none;">
      <span style="color: var(--accent); margin-right: 6px;">▾</span>
      How we measure
      <span class="muted" style="font-weight: 400; font-size: 12.5px;">— click to collapse</span>
    </summary>
    <div style="padding: 0 18px 14px 18px;">
      <p style="margin: 0"><strong>The report's primary comparison metric is <span style="color: var(--accent);">weighted \$/pass</span></strong> — the dollars you'd spend to get one grounded pass on your workload, penalizing passes that succeeded by narration instead of real work.</p>
      <span class="formula">weighted \$/pass  =  \$/pass  ÷  (trajectory_score / 100)</span>
      <p style="margin: 10px 0 0 0">Raw \$/pass counts every passing exit-code as equal. Trajectory score (0-100) is a canaryone-judge composite of Action + Grounding + Verification + Efficiency — how the model actually got to the answer. Weighted \$/pass collapses "cheap" and "actually good" into one number so there's a single best per run, not a Pareto curve.</p>
    </div>
  </details>
</section>`;
}
