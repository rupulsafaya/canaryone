// Hero section — title + metadata + two collapsible explainers:
//   • "What happened in this run" — first-time-viewer onboarding
//   • "How we measure" — semantics of the primary metric

import type { RunData } from '../data.js';
import { escapeHtml } from '../template.js';
import { fmtDollars, fmtDuration } from '../../lib/fmt.js';
import { lockupInline } from '../brand.js';

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

  // Task list for the onboarding block
  const taskFiles = [...new Set(sessions.map((s) => s.task_file))];
  const laneList = [...lanes];

  return `
<section id="hero">
  <h1 class="hero-title">${lockupInline(30)}<span class="sep" aria-hidden="true">·</span><span>Run report</span></h1>
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
      What happened in this run
      <span class="muted" style="font-weight: 400; font-size: 12.5px;">— read this first</span>
    </summary>
    <div style="padding: 0 18px 14px 18px;">
      <p style="margin: 0 0 10px 0;"><strong>canaryone</strong> is a local CLI. Point it at your codebase, and it runs your own tests against multiple LLM providers to compare cost and quality on <em>real work</em> — the LLM your test would normally call gets swapped for whichever provider we're benchmarking. It runs on your machine, against your own tests.</p>
      <p style="margin: 0 0 10px 0;">For this run, canaryone:</p>
      <ol style="margin: 0 0 12px 20px; padding: 0; line-height: 1.7;">
        <li>Read your target repo at <code>${targetDir}</code>.</li>
        <li>Ran ${taskFiles.length > 1 ? `${taskFiles.length} tests` : `<code>${escapeHtml(taskFiles[0] ?? '(no test)')}</code>`} <strong>${repeats} time${repeats === 1 ? '' : 's'} each</strong> against ${lanes.size} lane${lanes.size === 1 ? '' : 's'}:${taskFiles.length > 1 ? '' : ''}
          <ul style="margin: 6px 0 6px 0; padding-left: 20px; line-height: 1.6;">
            ${laneList.map((l) => `<li><code>${escapeHtml(l)}</code></li>`).join('')}
          </ul>
          Every LLM call the test made was rerouted through canaryone's <strong>local proxy</strong> — same test code, same model weights, only the provider (and its price / latency / behavior) differs.
        </li>
        <li>After each session finished, a <strong>second LLM</strong> — Claude Haiku 4.5, called <em>the judge</em> — read the transcript and scored the work 0-100.</li>
        <li>Wrote ${sessions.length} sessions of results to <code>.c1/db.sqlite</code> and rendered this report.</li>
      </ol>
      <p style="margin: 0 0 8px 0;"><strong>Terms you'll see below:</strong></p>
      <dl style="display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0;">
        <dt style="color: var(--muted); font-family: 'SF Mono', ui-monospace, monospace; font-size: 12px;">Lane</dt>
        <dd style="margin: 0; font-size: 13px;">one <code>(model, provider)</code> pair — a comparison target.</dd>
        <dt style="color: var(--muted); font-family: 'SF Mono', ui-monospace, monospace; font-size: 12px;">Session</dt>
        <dd style="margin: 0; font-size: 13px;">one execution of one test on one lane. Each session runs your test end-to-end and records every LLM call.</dd>
        <dt style="color: var(--muted); font-family: 'SF Mono', ui-monospace, monospace; font-size: 12px;">Repeat / attempt</dt>
        <dd style="margin: 0; font-size: 13px;">canaryone runs each session <code>N</code> times to smooth out variance. "Attempt 3/3" = the third repeat of that session.</dd>
        <dt style="color: var(--muted); font-family: 'SF Mono', ui-monospace, monospace; font-size: 12px;">Judge</dt>
        <dd style="margin: 0; font-size: 13px;">the second LLM (Claude Haiku 4.5) that reads each session's transcript and scores it.</dd>
        <dt style="color: var(--muted); font-family: 'SF Mono', ui-monospace, monospace; font-size: 12px;">Judge score</dt>
        <dd style="margin: 0; font-size: 13px;">a composite 0-100 that captures <em>how</em> the model worked — not just whether the test passed. See "How we measure" below.</dd>
      </dl>
    </div>
  </details>

  <details open class="metric-primer" style="display: block; padding: 0; margin-top: 10px;">
    <summary style="cursor: pointer; padding: 14px 18px; font-weight: 600; list-style: none; outline: none;">
      <span style="color: var(--accent); margin-right: 6px;">▾</span>
      How we measure
      <span class="muted" style="font-weight: 400; font-size: 12.5px;">— what the numbers below mean</span>
    </summary>
    <div style="padding: 0 18px 14px 18px;">
      <p style="margin: 0;"><strong>The report's primary comparison metric is <span style="color: var(--accent);">weighted \$/pass</span></strong> — the dollars you'd spend to get one <em>grounded</em> pass on your workload. It penalises passes where the test succeeded but the model didn't do real work (e.g. narrated a plausible answer instead of grounding in tool results).</p>
      <span class="formula">weighted \$/pass  =  \$/pass  ÷  (judge score / 100)</span>
      <p style="margin: 10px 0 0 0;">Raw \$/pass counts every passing exit-code as equal. The <strong>judge score</strong> (0-100) is a composite of four sub-scores of 25 each — two computed deterministically from the wire log (<em>Action</em>, <em>Efficiency</em>) and two scored by the judge LLM (<em>Grounding</em>, <em>Verification</em>). A low judge score with a passing test means "the test passed but the model didn't really do the work" — the ⚠ badge flags this on scores under 50.</p>
      <p style="margin: 10px 0 0 0;">Weighted \$/pass collapses "cheap" and "actually good" into one number so there's a single winner per run, not a Pareto curve.</p>
    </div>
  </details>
</section>`;
}
