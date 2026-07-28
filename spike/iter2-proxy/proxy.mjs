#!/usr/bin/env node
// c1 iter2 SPIKE — proxy v2. Handles:
//   - non-streaming /v1/messages with content-block translation
//   - streaming /v1/messages (SSE) with OpenAI-delta → Anthropic-event translation
//   - tool_use / tool_result round-tripping
// Prints every step so we can see what's on the wire.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 11435);
const OR_KEY = process.env.OPENROUTER_API_KEY;
const TARGET_MODEL = process.env.TARGET_MODEL ?? 'deepseek/deepseek-v4-flash';
const TARGET_PROVIDER = process.env.TARGET_PROVIDER || null;

if (!OR_KEY) { console.error('OPENROUTER_API_KEY required'); process.exit(1); }

const trunc = (s, n=250) => typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s;
function log(kind, obj) {
  const compact = JSON.stringify(obj, (_k, v) => typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v);
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${kind}  ${compact}`);
}

// ---------- Anthropic → OpenAI request translation ----------

function anthropicToOpenAI(a) {
  const messages = [];
  if (a.system) {
    const sys = typeof a.system === 'string' ? a.system : a.system.map(b => b.text ?? '').join('\n\n');
    messages.push({ role: 'system', content: sys });
  }
  for (const m of (a.messages ?? [])) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    // Content blocks
    if (m.role === 'assistant') {
      const textParts = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const toolCalls = m.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg = { role: 'assistant' };
      if (textParts) msg.content = textParts;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (!msg.content && !msg.tool_calls) msg.content = '';
      messages.push(msg);
      continue;
    }
    // user role — may contain tool_result blocks. OpenAI needs role:"tool" for each tool_result.
    const textParts = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const toolResults = m.content.filter(b => b.type === 'tool_result');
    if (textParts) messages.push({ role: 'user', content: textParts });
    for (const tr of toolResults) {
      const content = typeof tr.content === 'string' ? tr.content
        : Array.isArray(tr.content) ? tr.content.map(b => b.text ?? '').join('\n')
        : JSON.stringify(tr.content);
      messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content });
    }
  }

  const body = { model: TARGET_MODEL, messages, max_tokens: a.max_tokens ?? 1024 };
  if (a.temperature != null) body.temperature = a.temperature;
  if (a.top_p != null) body.top_p = a.top_p;
  if (a.stream) body.stream = true;
  if (a.tools && a.tools.length) {
    body.tools = a.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? {} },
    }));
  }
  if (a.tool_choice) {
    if (a.tool_choice.type === 'auto') body.tool_choice = 'auto';
    else if (a.tool_choice.type === 'any') body.tool_choice = 'required';
    else if (a.tool_choice.type === 'tool') body.tool_choice = { type: 'function', function: { name: a.tool_choice.name } };
  }
  if (TARGET_PROVIDER) body.provider = { order: [TARGET_PROVIDER] };
  return body;
}

// ---------- OpenAI → Anthropic response translation (non-streaming) ----------

function openAIToAnthropic(o, originalModel) {
  const choice = o.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of (msg.tool_calls ?? [])) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments ?? '{}'); } catch { input = { _raw: tc.function?.arguments }; }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const stopMap = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
  return {
    id: o.id ?? `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: originalModel,
    content,
    stop_reason: stopMap[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: o.usage?.prompt_tokens ?? 0, output_tokens: o.usage?.completion_tokens ?? 0 },
  };
}

// ---------- OpenAI SSE → Anthropic SSE translation ----------
//
// OpenAI stream: `data: {choices: [{delta: {content?, tool_calls?[index,id,function.{name,arguments}]}, finish_reason?}]}` ... `data: [DONE]`
// Anthropic stream: typed events emitted as `event: <name>\ndata: {...}\n\n`
//   message_start / content_block_start / content_block_delta / content_block_stop / message_delta / message_stop / ping
//
// A content block is either a text block or a tool_use block. Text lives in one block (index 0 by convention when text-only).
// Tool calls each get their own block, indexed by OpenAI's tool_calls[].index (offset by number of text blocks).

function makeSSETranslator(originalModel, writer) {
  let messageStartSent = false;
  let textBlockOpen = false;    // block 0
  const toolBlocks = new Map(); // key: openaiToolIdx -> {anthBlockIdx, name, id, argAcc}
  let anthBlockCounter = 0;     // next available anthropic block index
  let usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = null;

  const emit = (event, data) => {
    writer(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  function ensureMessageStart(openaiId) {
    if (messageStartSent) return;
    messageStartSent = true;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: openaiId ?? `msg_${randomUUID()}`,
        type: 'message', role: 'assistant', model: originalModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  function ensureTextBlockOpen() {
    if (textBlockOpen) return 0;
    textBlockOpen = true;
    const idx = anthBlockCounter++;
    emit('content_block_start', {
      type: 'content_block_start', index: idx,
      content_block: { type: 'text', text: '' },
    });
    return idx;
  }
  function ensureToolBlockOpen(openaiToolIdx, id, name) {
    let entry = toolBlocks.get(openaiToolIdx);
    if (entry) return entry;
    const anthIdx = anthBlockCounter++;
    entry = { anthIdx, id, name, argAcc: '' };
    toolBlocks.set(openaiToolIdx, entry);
    emit('content_block_start', {
      type: 'content_block_start', index: anthIdx,
      content_block: { type: 'tool_use', id, name, input: {} },
    });
    return entry;
  }

  return {
    handleChunk(line) {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(payload); } catch { return; }
      const choice = obj.choices?.[0];
      if (!choice) {
        if (obj.usage) { usage = { input_tokens: obj.usage.prompt_tokens ?? 0, output_tokens: obj.usage.completion_tokens ?? 0 }; }
        return;
      }
      ensureMessageStart(obj.id);
      const delta = choice.delta ?? {};
      if (delta.content) {
        const idx = ensureTextBlockOpen();
        emit('content_block_delta', {
          type: 'content_block_delta', index: idx,
          delta: { type: 'text_delta', text: delta.content },
        });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const openaiIdx = tc.index ?? 0;
          // Look up or open the block. Name/id may arrive across chunks.
          let entry = toolBlocks.get(openaiIdx);
          if (!entry) {
            const id = tc.id ?? `tool_${openaiIdx}_${Date.now()}`;
            const name = tc.function?.name ?? '';
            entry = ensureToolBlockOpen(openaiIdx, id, name);
          }
          if (tc.function?.name && !entry.name) entry.name = tc.function.name;
          if (tc.function?.arguments) {
            entry.argAcc += tc.function.arguments;
            emit('content_block_delta', {
              type: 'content_block_delta', index: entry.anthIdx,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }
      if (choice.finish_reason) {
        const map = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
        stopReason = map[choice.finish_reason] ?? 'end_turn';
      }
      if (obj.usage) usage = { input_tokens: obj.usage.prompt_tokens ?? 0, output_tokens: obj.usage.completion_tokens ?? 0 };
    },
    finish() {
      // Close open blocks in the order they were opened.
      if (textBlockOpen) emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      for (const entry of toolBlocks.values()) {
        emit('content_block_stop', { type: 'content_block_stop', index: entry.anthIdx });
      }
      emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
        usage,
      });
      emit('message_stop', { type: 'message_stop' });
    },
  };
}

// ---------- Forwarders ----------

async function forwardNonStreaming(oaiBody) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${OR_KEY}`, 'content-type': 'application/json', 'x-title': 'c1-spike' },
    body: JSON.stringify(oaiBody),
  });
  const text = await res.text();
  if (!res.ok) { log('OR_ERROR', { status: res.status, body: text.slice(0, 400) }); throw new Error(`OR ${res.status}: ${text.slice(0, 200)}`); }
  const body = JSON.parse(text);
  log('OR_RESP', { model: body.model, provider: body.provider, usage: body.usage, ms: Date.now() - t0, has_tool_calls: !!body.choices?.[0]?.message?.tool_calls });
  return body;
}

async function forwardStreaming(oaiBody, resWriter, originalModel) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${OR_KEY}`, 'content-type': 'application/json', 'accept': 'text/event-stream', 'x-title': 'c1-spike-stream' },
    body: JSON.stringify(oaiBody),
  });
  if (!res.ok) { const t = await res.text(); log('OR_STREAM_ERROR', { status: res.status, body: t.slice(0, 400) }); throw new Error(`OR ${res.status}: ${t.slice(0, 200)}`); }
  log('OR_STREAM_STARTED', { ms: Date.now() - t0 });

  const translator = makeSSETranslator(originalModel, resWriter);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // OpenAI SSE lines are separated by \n\n; each event is one or more lines starting with data:
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) if (line.startsWith('data:')) translator.handleChunk(line);
    }
  }
  translator.finish();
  log('STREAM_DONE', { total_ms: Date.now() - t0 });
}

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ spike: true, port: PORT, target_model: TARGET_MODEL }));
    }
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'spike only serves POST /v1/messages' }));
    }
    try {
      const anth = JSON.parse(body);
      const originalModel = anth.model;
      const isStream = anth.stream === true;
      const oai = anthropicToOpenAI(anth);
      log(isStream ? 'IN_STREAM' : 'IN_NONSTREAM', {
        model: originalModel, max: anth.max_tokens, msgs: anth.messages?.length,
        sys_len: typeof anth.system === 'string' ? anth.system.length : 0,
        tools: anth.tools?.length ?? 0,
        has_tool_result: anth.messages?.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')),
      });

      if (isStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
        await forwardStreaming(oai, chunk => res.write(chunk), originalModel);
        res.end();
      } else {
        const orResp = await forwardNonStreaming(oai);
        const anthResp = openAIToAnthropic(orResp, originalModel);
        log('OUT_NONSTREAM', { id: anthResp.id, blocks: anthResp.content.length, stop: anthResp.stop_reason, tools: anthResp.content.filter(c => c.type === 'tool_use').length });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(anthResp));
      }
    } catch (e) {
      log('SPIKE_ERROR', { err: String(e) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`c1-spike proxy v2 on :${PORT} — ${TARGET_MODEL}${TARGET_PROVIDER ? ` @ ${TARGET_PROVIDER}` : ''}  (streaming + tools)`);
});
