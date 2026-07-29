// Pre-run lane probe. Fires a minimal chat completion (max_tokens=1) with
// the exact wire slug + routing headers we'd use at run time, so we catch
// account suspensions, per-model entitlement gates, invalid tokens, and
// provider outages BEFORE spending 20 minutes on a run that dies halfway.
//
// Cost: ~$0.0005-0.005 per lane depending on provider pricing on a 1-token
// probe. Six-lane preflight is well under a cent.

import type { LaneSpec } from '../runner/orchestrator.js';

export type PreflightCategory =
  | 'ok'
  | 'auth'          // 401/403 not tied to model access
  | 'billing'       // 402/412 or explicit billing error messages
  | 'model-access'  // 403/404 with model-not-available message
  | 'rate-limit'    // 429
  | 'timeout'       // network timeout
  | 'network'       // fetch threw
  | 'other';        // 4xx/5xx we didn't classify

export interface PreflightResult {
  ok: boolean;                    // green light — include in the run
  category: PreflightCategory;
  httpStatus: number | null;
  latencyMs: number | null;
  message: string;                // one-line reason, user-facing
  detail?: string;                // longer body snippet for the fix panel
}

const PROBE_TIMEOUT_MS = 12_000;

export async function probeLane(lane: LaneSpec): Promise<PreflightResult> {
  const t0 = Date.now();
  const body: Record<string, unknown> = {
    model: lane.modelSlugForForward ?? lane.modelSlug,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  };
  // Same gateway routing hints lane.ts uses at run time — if a lane will
  // route through OR's provider.order to Baseten at run time, the preflight
  // must too, otherwise the probe passes but the run fails.
  if (lane.router === 'openrouter' && lane.providerTag) {
    body.provider = { order: [lane.providerTag] };
  } else if (lane.router === 'vercel' && lane.providerTag) {
    body.providerOptions = { gateway: { only: [lane.providerTag] } };
  }

  const forwardUrl = lane.forwardUrl;
  const apiKey = lane.apiKey;
  if (!forwardUrl || !apiKey) {
    return {
      ok: false,
      category: 'other',
      httpStatus: null,
      latencyMs: null,
      message: 'lane missing forwardUrl or apiKey (bug — file an issue)',
    };
  }

  let res: Response;
  try {
    res = await fetch(forwardUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Title': 'canaryone-preflight',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = msg.toLowerCase().includes('timeout') || msg.includes('aborted');
    return {
      ok: false,
      category: isTimeout ? 'timeout' : 'network',
      httpStatus: null,
      latencyMs: Date.now() - t0,
      message: isTimeout ? `probe timed out after ${PROBE_TIMEOUT_MS}ms` : `network error: ${msg.slice(0, 100)}`,
    };
  }
  const latencyMs = Date.now() - t0;

  const rawText = await res.text().catch(() => '');
  let bodyJson: unknown;
  try { bodyJson = JSON.parse(rawText); } catch { /* leave as text */ }

  if (res.ok) {
    return { ok: true, category: 'ok', httpStatus: res.status, latencyMs, message: `${res.status} in ${latencyMs}ms` };
  }

  const errText = extractErrorText(bodyJson) || rawText.slice(0, 200);
  return classify(res.status, errText, latencyMs);
}

function extractErrorText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  const err = b.error ?? b.errors ?? b.detail ?? b.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    if (Array.isArray(err)) {
      const first = err[0] as Record<string, unknown> | undefined;
      if (first && typeof first.message === 'string') return first.message;
    }
  }
  if (Array.isArray(b.errors)) {
    const first = (b.errors as Record<string, unknown>[])[0];
    if (first && typeof first.message === 'string') return first.message;
  }
  return typeof b.message === 'string' ? b.message : '';
}

function classify(httpStatus: number, message: string, latencyMs: number): PreflightResult {
  const lo = message.toLowerCase();
  const isBilling = /suspend|billing|invoice|spending limit|payment|upgrade|paid plan|free plan|credits/.test(lo);
  const isModelAccess = /model.*not.*avail|do not have access|does not exist|unknown model|model.*not.*found|entitl/.test(lo);
  const isRate = /rate.?limit|too many/.test(lo);

  if (httpStatus === 401) {
    return { ok: false, category: 'auth', httpStatus, latencyMs, message: 'invalid API key (401)', detail: message };
  }
  if (httpStatus === 402 || httpStatus === 412 || (httpStatus === 403 && isBilling)) {
    return { ok: false, category: 'billing', httpStatus, latencyMs, message: `billing / quota: ${message.slice(0, 120)}`, detail: message };
  }
  if (httpStatus === 403 && isModelAccess) {
    return { ok: false, category: 'model-access', httpStatus, latencyMs, message: `model access denied: ${message.slice(0, 120)}`, detail: message };
  }
  if (httpStatus === 403) {
    return { ok: false, category: 'auth', httpStatus, latencyMs, message: `403 Forbidden: ${message.slice(0, 120)}`, detail: message };
  }
  if (httpStatus === 404 && isModelAccess) {
    return { ok: false, category: 'model-access', httpStatus, latencyMs, message: `model not found: ${message.slice(0, 120)}`, detail: message };
  }
  if (httpStatus === 429 || isRate) {
    return { ok: false, category: 'rate-limit', httpStatus, latencyMs, message: `rate limited (429)`, detail: message };
  }
  return {
    ok: false,
    category: 'other',
    httpStatus,
    latencyMs,
    message: `HTTP ${httpStatus}${message ? `: ${message.slice(0, 100)}` : ''}`,
    detail: message,
  };
}

/**
 * Probe all lanes in parallel. Returns a Record keyed by laneKey
 * (`${wireSlug}@${destinationSlug}`) so callers can render + gate consistently.
 */
export async function probeLanes(
  lanes: LaneSpec[],
): Promise<Array<{ lane: LaneSpec; result: PreflightResult }>> {
  return Promise.all(lanes.map(async (lane) => ({ lane, result: await probeLane(lane) })));
}

/**
 * Aggregate summary: how many blocking failures (auth / billing / model-access
 * — the ones that will never spontaneously recover mid-run) and how many
 * soft warnings (timeout / rate-limit / network — could just be flaky).
 */
export function summarizePreflight(results: PreflightResult[]): {
  ok: number;
  blocking: number;
  warning: number;
} {
  let ok = 0, blocking = 0, warning = 0;
  for (const r of results) {
    if (r.ok) ok++;
    else if (r.category === 'auth' || r.category === 'billing' || r.category === 'model-access') blocking++;
    else warning++;
  }
  return { ok, blocking, warning };
}
