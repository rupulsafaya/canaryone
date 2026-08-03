// Per-lane HTTP proxy — listens on an ephemeral port, receives subprocess
// SDK calls with OPENAI_BASE_URL=http://localhost:<port>/v1, rewrites
// (model, provider.order) to the lane's configured (model, destination),
// forwards to OpenRouter, and records the round-trip to the wire log.
//
// M1 scope:
//   ✓ POST /v1/chat/completions  (non-streaming; OpenAI-compat inbound)
//   ✓ GET  /v1/models             (some SDKs probe this on init)
//   ✓ GET  /                      (diagnostics)
//   ✗ Streaming (D4)
//   ✗ POST /v1/messages           (Anthropic native — D3 translator)
//   ✗ Tool round-trip (D5)

import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { TrafficLog } from '../runner/traffic-log.js';
import type { Db, StepRow } from '../db/sqlite.js';
import type { OrEndpoint, CatalogModel } from '../data/schema.js';

export interface LaneConfig {
  runId: string;
  sessionId: string;
  modelSlug: string;                    // canonical slug — DB + reporting
  /** Provider-native slug placed on the wire in body.model. Often equals modelSlug. */
  modelSlugForForward: string;
  destinationSlug: string;              // e.g. "openrouter:baseten/fp8"
  router: string;                       // e.g. "openrouter" | "vercel" | "cloudflare" | "direct"
  providerTag: string | null;           // OR provider tag (e.g. "baseten/fp8"); null for non-OR routers
  endpoint: OrEndpoint | null;          // preferred pricing source (per-provider)
  fallbackModelPrice: { input: number; output: number } | null;  // model-level $/M from OR catalog; used when endpoint is null
  /** Chat-completions URL to POST to. Was hard-coded to OR pre-A5. */
  forwardUrl: string;
  /** Bearer token for the provider. Was hard-coded to spec.orKey pre-A5. */
  apiKey: string;
  /**
   * Run-wide sampling pins. When set, the outbound body's temperature/seed
   * are forced to these values (overriding whatever the subprocess sent).
   */
  pinTemperature?: number;
  pinSeed?: number;
  /**
   * Called after each successful chat/completions response with per-request
   * deltas. Used by the orchestrator to emit session:step so LiveProgress
   * can show live token / cost / step counts instead of waiting until the
   * session ends. Errors during forward (setup, timeout) do NOT fire.
   */
  onStep?: (delta: { stepIx: number; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number }) => void;
}

export interface LaneServer {
  port: number;
  stepCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  close(): Promise<void>;
}

export const OR_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function startLane(cfg: LaneConfig, log: TrafficLog, db: Db): Promise<LaneServer> {
  let stepIx = 0;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, cfg, log, db, () => stepIx++, (cost, inTok, outTok) => {
      costUsd += cost;
      inputTokens += inTok;
      outputTokens += outTok;
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('proxy failed to bind ephemeral port'));
    });
    server.on('error', reject);
  });

  return {
    port,
    get stepCount() { return stepIx; },
    get costUsd() { return costUsd; },
    get inputTokens() { return inputTokens; },
    get outputTokens() { return outputTokens; },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: LaneConfig,
  log: TrafficLog,
  db: Db,
  nextStepIx: () => number,
  addCost: (cost: number, inputTokens: number, outputTokens: number) => void,
): Promise<void> {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      canaryone: true,
      run_id: cfg.runId,
      session_id: cfg.sessionId,
      lane: { model: cfg.modelSlug, destination: cfg.destinationSlug },
    }));
    return;
  }

  if (req.method === 'GET' && url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: cfg.modelSlug, object: 'model', created: 0, owned_by: cfg.router }],
    }));
    return;
  }

  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    await handleChatCompletions(req, res, cfg, log, db, nextStepIx(), addCost);
    return;
  }

  // Fallthrough: unsupported path — tell the caller which shapes we speak.
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      message: `canaryone lane proxy does not serve ${req.method} ${url}. Supported: POST /v1/chat/completions, GET /v1/models, GET /`,
      type: 'canaryone_unsupported',
    },
  }));
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: LaneConfig,
  log: TrafficLog,
  db: Db,
  stepIx: number,
  addCost: (cost: number, inputTokens: number, outputTokens: number) => void,
): Promise<void> {
  const stepId = randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const rawBody = await readBody(req);
  let inbound: Record<string, unknown>;
  try {
    inbound = JSON.parse(rawBody);
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    await log.append({
      ts: new Date().toISOString(),
      kind: 'error',
      run_id: cfg.runId,
      session_id: cfg.sessionId,
      step_id: stepId,
      step_ix: stepIx,
      path: '/v1/chat/completions',
      error: `invalid JSON: ${errText}`,
    });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `invalid JSON body: ${errText}`, type: 'canaryone_bad_request' } }));
    return;
  }

  // Rewrite: model (per-provider wire slug) + gateway routing hints (varies
  // by router). Both OR and Vercel accept an underlying-provider filter but
  // in different fields — direct providers ignore both. Also inject any
  // run-wide sampling pins so all lanes sample from the same policy.
  const rewritten: Record<string, unknown> = {
    ...inbound,
    model: cfg.modelSlugForForward,
    stream: false,   // M1 forces non-streaming; streaming lands in D4.
  };
  if (cfg.pinTemperature !== undefined) rewritten.temperature = cfg.pinTemperature;
  if (cfg.pinSeed !== undefined) rewritten.seed = cfg.pinSeed;

  // OpenAI deprecated `max_tokens` in favor of `max_completion_tokens` for
  // reasoning-family models — the new field also accounts for hidden
  // reasoning tokens. Per OpenAI's official statement (community thread from
  // Sep 2024): "max_tokens continues to be supported in all existing models,
  // but the o1 series only supports max_completion_tokens." Extended by our
  // 2026-07-31 probes to gpt-5+ (returns HTTP 400 on max_tokens).
  //
  // Only rewrite for the model families that REQUIRE it — o-series (o1..o9)
  // and gpt-5+ family. Don't blanket-rename for gpt-4o etc; those still
  // accept max_tokens and blanket-rewrite would change billing semantics
  // (max_completion_tokens counts reasoning tokens differently). See the
  // LangChain langchain-ai/docs#455 complaint for why the aggressive path is
  // wrong.
  //
  // Also strip any vendor prefix before matching — for OR-routed lanes the
  // model on the wire is `openai/gpt-5-nano`, for direct it's `gpt-5-nano`.
  const wireModel = typeof rewritten.model === 'string' ? rewritten.model : '';
  const bareModel = wireModel.includes('/') ? wireModel.slice(wireModel.lastIndexOf('/') + 1) : wireModel;
  if (
    rewritten.max_tokens != null &&
    rewritten.max_completion_tokens == null &&
    /^(gpt-[5-9]|o[1-9])(-|\.|$)/i.test(bareModel)
  ) {
    rewritten.max_completion_tokens = rewritten.max_tokens;
    delete rewritten.max_tokens;
  }
  if (cfg.router === 'openrouter' && cfg.providerTag) {
    rewritten.provider = { order: [cfg.providerTag] };
  } else if (cfg.router === 'vercel' && cfg.providerTag) {
    // Vercel AI Gateway uses providerOptions.gateway.only to pin a specific
    // underlying provider. See:
    // https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering
    const existing = (inbound as Record<string, unknown>).providerOptions;
    const base = existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};
    const gateway = base.gateway && typeof base.gateway === 'object'
      ? { ...(base.gateway as Record<string, unknown>) }
      : {};
    gateway.only = [cfg.providerTag];
    base.gateway = gateway;
    rewritten.providerOptions = base;
  }

  // Log the request (pre-forward).
  const reqRecord = await log.append({
    ts: startedAt,
    kind: 'request',
    run_id: cfg.runId,
    session_id: cfg.sessionId,
    step_id: stepId,
    step_ix: stepIx,
    lane: { model: cfg.modelSlug, destination: cfg.destinationSlug },
    inbound_shape: 'openai',
    path: '/v1/chat/completions',
    body: inbound,
  });

  // Forward to the lane's configured router / direct-provider.
  let orResp: Response;
  let orBodyText: string;
  try {
    orResp = await fetch(cfg.forwardUrl, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
        'x-title': 'canaryone',
      },
      body: JSON.stringify(rewritten),
    });
    orBodyText = await orResp.text();
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    await log.append({
      ts: new Date().toISOString(),
      kind: 'error',
      run_id: cfg.runId,
      session_id: cfg.sessionId,
      step_id: stepId,
      step_ix: stepIx,
      path: '/v1/chat/completions',
      error: `forward failed: ${errText}`,
      latency_ms: Date.now() - t0,
    });
    persistStep(db, {
      id: stepId, session_id: cfg.sessionId, step_ix: stepIx,
      started_at: startedAt, finished_at: new Date().toISOString(),
      http_status: null, inbound_shape: 'openai', path: '/v1/chat/completions',
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      latency_ms: Date.now() - t0,
      translation_notes: null,
      traffic_log_offset: reqRecord.offset, traffic_log_length: reqRecord.length,
      failure_class: 'forward_failed',
    });
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: errText, type: 'canaryone_forward_failed' } }));
    return;
  }

  // Try parsing OR body for usage; even on !ok, keep original body text.
  let orBody: Record<string, any> | null = null;
  try { orBody = JSON.parse(orBodyText); } catch { orBody = null; }

  // Provider quirk fix: some serverless deployments (observed on Together's
  // Qwen3 family) don't extract Qwen's native <tool_call>...</tool_call>
  // XML into the OpenAI-compat `tool_calls` array on multi-turn calls —
  // the raw XML lands in `message.reasoning_content` instead. Detect and
  // repair; if we rewrite the body, propagate the fixed JSON to the SDK
  // client too so the agent loop can see the tool calls.
  if (orBody && repairQwenXmlToolCalls(orBody)) {
    orBodyText = JSON.stringify(orBody);
  }

  const usage = orBody?.usage ?? null;
  const inputTokens = Number(usage?.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(usage?.completion_tokens ?? 0) || 0;
  const cost = computeCost(inputTokens, outputTokens, cfg.endpoint, cfg.fallbackModelPrice);
  addCost(cost, inputTokens, outputTokens);

  const latency = Date.now() - t0;
  const respRecord = await log.append({
    ts: new Date().toISOString(),
    kind: 'response',
    run_id: cfg.runId,
    session_id: cfg.sessionId,
    step_id: stepId,
    step_ix: stepIx,
    lane: { model: cfg.modelSlug, destination: cfg.destinationSlug },
    inbound_shape: 'openai',
    path: '/v1/chat/completions',
    body: orBody ?? { _raw: orBodyText.slice(0, 4000) },
    usage: usage ? { input_tokens: inputTokens, output_tokens: outputTokens } : undefined,
    latency_ms: latency,
    cost_usd: cost,
    http_status: orResp.status,
  });

  persistStep(db, {
    id: stepId, session_id: cfg.sessionId, step_ix: stepIx,
    started_at: startedAt, finished_at: new Date().toISOString(),
    http_status: orResp.status,
    inbound_shape: 'openai', path: '/v1/chat/completions',
    input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost,
    latency_ms: latency,
    translation_notes: null,
    // Points at the REQUEST record so SessionInspector can walk the pair.
    traffic_log_offset: reqRecord.offset,
    traffic_log_length: (respRecord.offset - reqRecord.offset) + respRecord.length,
    failure_class: orResp.ok ? null : classifyOrFailure(orResp.status),
  });

  // Notify the orchestrator so LiveProgress can update in-run.
  // Values are per-request deltas; the store accumulates them.
  try {
    cfg.onStep?.({ stepIx, inputTokens, outputTokens, costUsd: cost, latencyMs: latency });
  } catch { /* subscriber errors don't break the proxy */ }

  // Passthrough response verbatim to the SDK client.
  res.writeHead(orResp.status, { 'content-type': orResp.headers.get('content-type') ?? 'application/json' });
  res.end(orBodyText);
}

function persistStep(db: Db, row: StepRow): void {
  try { db.insertStep(row); } catch { /* SQLite failure is non-fatal — JSONL is source of truth */ }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function computeCost(
  input: number,
  output: number,
  endpoint: OrEndpoint | null,
  fallback: { input: number; output: number } | null,
): number {
  // Per-provider endpoint pricing is preferred (accurate for the specific
  // (router, provider) combo). Falls back to model-level $/M from the OR
  // catalog rankings when the endpoint lookup missed.
  const inPrice = endpoint?.inputPrice ?? fallback?.input ?? 0;
  const outPrice = endpoint?.outputPrice ?? fallback?.output ?? 0;
  return (input / 1_000_000) * inPrice + (output / 1_000_000) * outPrice;
}

function classifyOrFailure(status: number): string {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 400) return 'bad_request';
  if (status >= 500) return 'destination_unavailable';
  return `http_${status}`;
}

// ---------- Qwen XML tool-call repair ----------

// Match one `<tool_call>...</tool_call>` block with `<function=NAME>` + zero
// or more `<parameter=KEY>VALUE</parameter>` children. Multiline; VALUE keeps
// its leading/trailing whitespace so we can trim per-parameter.
const QWEN_TOOL_CALL_RE = /<tool_call>\s*<function=([\w.-]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
const QWEN_PARAM_RE = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g;

/**
 * Detect and repair Qwen-native `<tool_call>` XML that leaked into a chat
 * completion response's `message.reasoning_content` (or `reasoning`). When a
 * choice has empty `tool_calls` but its reasoning contains parseable XML,
 * synthesize the OpenAI-compat `tool_calls` array in place, flip
 * `finish_reason` to `tool_calls`, and strip the parsed XML out of the
 * reasoning text.
 *
 * Returns true iff the body was mutated. The caller re-serializes.
 */
export function repairQwenXmlToolCalls(body: any): boolean {
  if (!body || !Array.isArray(body.choices)) return false;
  let mutated = false;
  for (let i = 0; i < body.choices.length; i++) {
    const choice = body.choices[i];
    if (!choice || typeof choice !== 'object') continue;
    const msg = choice.message;
    if (!msg || typeof msg !== 'object') continue;
    const existing = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (existing.length > 0) continue; // already has parsed tool calls; leave alone
    const reasoningField = typeof msg.reasoning_content === 'string' ? 'reasoning_content'
      : typeof msg.reasoning === 'string' ? 'reasoning'
      : null;
    if (!reasoningField) continue;
    const src: string = msg[reasoningField];
    if (!src.includes('<tool_call>') && !src.includes('<function=')) continue;

    const parsed: any[] = [];
    let m: RegExpExecArray | null;
    QWEN_TOOL_CALL_RE.lastIndex = 0;
    while ((m = QWEN_TOOL_CALL_RE.exec(src)) !== null) {
      const fnName = m[1];
      const inner = m[2];
      const args: Record<string, string> = {};
      let pm: RegExpExecArray | null;
      QWEN_PARAM_RE.lastIndex = 0;
      while ((pm = QWEN_PARAM_RE.exec(inner)) !== null) {
        args[pm[1]] = pm[2].trim();
      }
      parsed.push({
        id: `call_qwen_xml_${i}_${parsed.length}_${Date.now().toString(36)}`,
        type: 'function',
        function: {
          name: fnName,
          arguments: JSON.stringify(args),
        },
      });
    }
    if (parsed.length === 0) continue;
    msg.tool_calls = parsed;
    // Strip the XML we consumed from the reasoning field, keep any surrounding prose.
    msg[reasoningField] = src.replace(QWEN_TOOL_CALL_RE, '').trim();
    // If reasoning is now empty, drop it entirely for cleaner downstream output.
    if (!msg[reasoningField]) delete msg[reasoningField];
    // Standard chat-completions finish_reason for a tool-calling response.
    if (choice.finish_reason === 'stop' || !choice.finish_reason) {
      choice.finish_reason = 'tool_calls';
    }
    mutated = true;
  }
  return mutated;
}

// ---------- convenience: port picking (used only for unit tests / diagnostics) ----------

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const p = addr.port;
        s.close(() => resolve(p));
      } else reject(new Error('failed to allocate port'));
    });
  });
}
