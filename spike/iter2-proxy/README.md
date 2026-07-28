# iter2 proxy — de-risk spike

Throwaway reference implementation that proves the load-bearing assumptions
of [`../../c1-runner-28july-SPEC.md`](../../c1-runner-28july-SPEC.md) Part B.
This code is **not production**. It's here so the iter2 build has a working
answer to "does the design actually work?" — and so amendments the SPEC picked
up from the spike are traceable back to their source.

## What was proven

Six patterns, all real network, real OpenRouter, real Anthropic SDK. Total
API cost: ~$0.001 across five spikes + ~$0.05-0.10 for the multi-turn workflow.

| # | Pattern | Script | Result |
|---|---|---|---|
| 1 | Non-streaming ping | `ping.mjs` | ✓ SDK deserialized cleanly, model rewrite worked |
| 2 | Real workload (unmodified `lib/judge.cjs` from `job-search-automation`) | `judge-one.mjs` | ✓ structured JSON verdict parsed by production code |
| 3 | Streaming plain text | `stream.mjs` | ✓ 6 event types, SDK reconstructed content |
| 4 | Non-streaming tool round-trip | `tool.mjs` | ✓ two rounds (tool_use → tool_result → final text) |
| 5 | Streaming + tool call | `stream-tool.mjs` | ✓ input_json_delta accumulation across chunks |
| 6 | Multi-turn agent (opencode against `node-express-realworld`, 3 parallel lanes) | Workflow (`wf_7ab7ae17`) | ✓ 8–11 turns per lane, all three produced correct code trace |

## What the spike caught (real bugs before iter2 shipped them)

- **TDZ error in tool-block SSE state machine** — `const entry = ensureToolBlockOpen(..., entry?.name ...)` referenced its own initializer. Would have shipped in iter2 without this spike.
- **opencode uses `@ai-sdk/anthropic` (Vercel wrapper), not raw `@anthropic-ai/sdk`** — real repos use SDK-of-SDKs stacks. Both hit `/v1/messages` but through different code paths. Iter1.5 methodology detection needs to recognize the wrapper (SDK seed list already covers `ai` + Vercel).
- **Latency spread across lanes: 25s ↔ 157s** — one global timeout would kill slow lanes unfairly. Prompted SPEC §13.4 amendment (per-lane timeout budget).
- **Aggregate turn/tool counts are insufficient** — one lane produced 11 turns with 0 tool calls and still answered correctly. Only per-turn full-body capture can distinguish real trajectories from confident-narration-from-training. Prompted SPEC §15.2 load-bearing requirement.

## How to reproduce

Prerequisites:
- `~/.c1/.env` with `OPENROUTER_API_KEY=sk-or-v1-…`
- Node 22+
- `@anthropic-ai/sdk` available via a nearby `node_modules/` (the spike uses
  `job-search-automation`'s installed copy — see the `createRequire()` line
  in `judge-one.mjs`)

```bash
# 1. Start the proxy for one lane
set -a && . ~/.c1/.env && set +a
TARGET_MODEL=deepseek/deepseek-v4-flash TARGET_PROVIDER=deepinfra/fp4 PORT=11435 \
  node spike/iter2-proxy/proxy.mjs &

# 2. Run any spike against it
cd spike/iter2-proxy
ANTHROPIC_BASE_URL=http://localhost:11435 node ping.mjs
ANTHROPIC_BASE_URL=http://localhost:11435 node stream.mjs
ANTHROPIC_BASE_URL=http://localhost:11435 node tool.mjs
ANTHROPIC_BASE_URL=http://localhost:11435 node stream-tool.mjs
ANTHROPIC_BASE_URL=http://localhost:11435 node judge-one.mjs

# 3. Multi-turn opencode against a real repo
OPENCODE_DISABLE_AUTOUPDATE=1 \
ANTHROPIC_BASE_URL=http://localhost:11435 \
ANTHROPIC_API_KEY=sk-proxy-dummy \
OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","provider":{"anthropic":{"npm":"@ai-sdk/anthropic","options":{"baseURL":"http://localhost:11435","apiKey":"sk-proxy-dummy"},"models":{"claude-sonnet-4-5-20250929":{}}}}}' \
opencode run --auto --dir ~/Documents/GitHub/node-express-realworld \
  -m anthropic/claude-sonnet-4-5-20250929 --format json \
  "Trace how a POST /api/users/login request is handled end-to-end."

# 4. Kill the proxy
pkill -f "spike/iter2-proxy/proxy.mjs"
```

## Design notes for the iter2 build

The spike proxy is ~320 lines. Production iter2 will need at least:

- **Multiple lane ports at once** — spike opens one port per process invocation. Production `src/proxy/manager.ts` owns port bookkeeping and lane-config lookup.
- **Persistence** — spike prints to stdout. Production writes to `.c1/runs/<run_id>/traffic.jsonl` (see SPEC §15.2) with per-turn granularity.
- **Error surface** — spike returns 500 with error text. Production distinguishes rate-limit / auth / destination-unavailable / translator-error and threads `failure_class` into SQLite.
- **Tool-call streaming edge cases** — spike handles the deepseek case (arguments arrive as JSON string fragments, `input_json_delta` per fragment). Other providers may batch differently. iter2 build should probe glm / anthropic native and record any variance in `translation_notes`.
- **Content-block ordering** — spike opens the text block at index 0 and tool blocks at 1+. Real Anthropic streams sometimes emit tool_use blocks before text (or interleaved). Iter2 translator should track block order from the OpenAI stream, not assume text-first.
- **Multi-modal content (images, documents)** — spike drops these with a note. iter2 either supports pass-through or explicitly errors with a clear message.

## Files

- `proxy.mjs` — the translator + forwarder
- `ping.mjs` — non-streaming plain text
- `judge-one.mjs` — non-streaming, real production workload
- `stream.mjs` — streaming plain text
- `tool.mjs` — non-streaming tool round-trip
- `stream-tool.mjs` — streaming + tool call combined

Multi-turn workflow (spike 6) was orchestrated via the Workflow tool; its
findings are captured in the SPEC amendments (§13.4, §15.2) rather than
checked in as a script because the invocation is Workflow-specific and
not directly replayable outside that harness.
