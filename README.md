# canaryone

**Benchmark your AI agent across every provider it could run on — using your own tests.**

`canaryone` reroutes the LLM calls your test suite already makes through 3 routers (OpenRouter, Vercel AI Gateway, AWS Bedrock) and 9 direct providers (Moonshot, Nebius, Fireworks, Together, Baseten, Groq, DeepSeek, Cerebras, and any others you configure), then reports **cost-per-passing-outcome + judged trajectory quality** side by side. No cloud, no account, no data leaves your machine.

```
Model          Provider              Router      pass    $/pass    judge   weighted $/pass
Kimi K3        Moonshot AI (mxfp4)   OpenRouter  12/12   $0.1852   88      $0.2104
Kimi K3        baseten               Vercel      11/12   $0.0967   84      $0.1151
Kimi K3        Fireworks             Vercel       9/12   $0.0921   86      $0.1071
Kimi K3        moonshot-intl         direct       9/12   $0.0686   87      $0.0789
Kimi K3        nebius                Vercel       6/12   $0.0472   69 ⚠    $0.0683
```

*Same model. Same test. 3.6× cost spread; one provider silently narrates instead of doing the work (⚠).*

## What this is for

- Choose the cheapest **grounded** route for your workload — not just the cheapest route.
- Catch providers that pass exit-code checks but drift into narrated bullshit under load.
- Compare underlying providers within a gateway (OpenRouter routing to Baseten vs OpenRouter routing to Fireworks) as separate lanes.
- Try a candidate model on your actual tasks before switching production.

## Install

Requires **Node ≥ 22**.

**Try it once (no install):**

```bash
cd ~/your-repo
npx canaryone                   # downloads, runs the TUI in ~/your-repo
```

`npx canaryone` fetches the package from npm on first run, caches it, and boots the TUI targeting the current directory. That single command *is* the launch — there's no separate setup step.

**Install for daily use:**

```bash
npm i -g canaryone              # exposes `canaryone` and `c1` on your PATH
c1                              # from any repo, boots the TUI
```

Both `canaryone` and `c1` resolve to the same binary. Use whichever you prefer.

## First run (30 seconds)

canaryone runs against **the tests you already have** — the ones that exercise your agent, your prompts, your tools. It finds them for you (see [How canaryone finds your AI-tests](#how-canaryone-finds-your-ai-tests)) and reroutes their LLM calls through every provider you want to compare.

The one requirement: those tests must **actually call an LLM at runtime**. Tests that stub or mock the model won't tell you anything about a provider — canaryone will surface them as "no LLM detected" in the Pick Tasks screen and let you skip them.

Point `canaryone` at your own repo:

```bash
cd ~/your-repo
npx canaryone                   # or `c1` if you installed globally
```

**Want to try it before pointing at your own repo?** [`canaryone-demo`](https://github.com/rupulsafaya/canaryone-demo) is a 4-tier difficulty ladder over a mini SaaS analytics fixture — you can test with this one:

```bash
git clone https://github.com/rupulsafaya/canaryone-demo.git
cd canaryone-demo && pnpm install
npx canaryone
```

You'll walk through:

1. **API keys** — paste tokens for the providers you want to compare. `OPENROUTER_API_KEY` is required (see [Why OpenRouter is required](#why-openrouter-is-required)); everything else is optional.
2. **Onboarding** — canaryone reads your `package.json` / `pyproject.toml`, finds test files, detects your LLM SDK.
3. **Methodology check** — the runner env-swaps the LLM base URL, so it needs your target to read that from env (not a hardcoded URL). Fails loud on hardcoded configs.
4. **Pick routes** — search-first UI over every model your configured providers serve. `kimi k3` shows you Kimi K3 across all 10+ routes it exists on.
5. **Confirm & run** — **preflight probes** every picked lane with a 1-token request before spending real time on a run. Fails on billing/auth/model-access issues in ~5 seconds.
6. **Live progress** — see pass/fail per (lane, task) cell in real time.
7. **HTML report** — cost-per-pass, weighted $/pass, trajectory quality per lane, plus per-session drilldowns. See [Viewing the report](#viewing-the-report).

## How canaryone finds your AI-tests

Two stages, run once per target and cached under `<target>/.c1/`:

1. **Deterministic scan** — `fast-glob` sweeps common test-file locations. It checks shallow directories first (`tests/agent/`, `tests/`, `test/`, `__tests__/`) then falls back to broader patterns for monorepos (`packages/*/tests/**`, `apps/*/tests/**`, `src/**/__tests__/**`). File patterns matched: `**/*.{spec,test}.{ts,tsx,js,mjs,cjs,py}`. Ignores `node_modules`, `dist`, `build`, `.next`, `coverage`, `.venv`.
2. **LLM summarization** — each matched test file is sent to `anthropic/claude-haiku-4.5` (via OpenRouter) with a prompt that returns: does this test call an LLM? what does it do? what evidence points to LLM use (e.g. imports `@anthropic-ai/sdk`, calls `judgeJob()`)? The output is what you see in the Pick Tasks screen.

The summaries cache to `.c1/scan/` — subsequent runs skip the LLM step unless you pass `--rescan`.

**Methodology detection** (a separate LLM call, same model) reads your source to figure out *how* your app calls its LLM: which SDK, which env var holds the base URL, and whether the URL is hardcoded (which would block canaryone's proxy from routing calls). Bypass its cache with `--rescan-methodology`.

## How your app's LLM calls get routed

canaryone doesn't patch your code. It puts a proxy between your test subprocess and each provider:

1. For every lane you picked, canaryone starts a **local HTTP proxy on an ephemeral port**.
2. It spawns your test subprocess with `OPENAI_BASE_URL=http://localhost:<port>/v1` (and equivalent env vars for other SDKs it detected).
3. Your test code calls what it thinks is OpenAI/Anthropic/whatever, but the request hits localhost.
4. The proxy rewrites `body.model` and any routing headers to target the specific lane (e.g. `openrouter:baseten/fp8`), then forwards to the real provider endpoint.
5. Every request/response is logged to `<target>/.c1/runs/<runId>/traffic.jsonl` for full audit.

Because the swap is env-only, your test code needs to read its base URL from env (`process.env.OPENAI_BASE_URL`, or whatever env var canaryone detected for your SDK). The **methodology check** fails loud if it finds a hardcoded URL — that's the one config change you need to make in your target repo.

## Why OpenRouter is required

`OPENROUTER_API_KEY` covers three things you can't opt out of:

- **Test summarization** — the scan step calls `anthropic/claude-haiku-4.5` to describe each test file.
- **Methodology detection** — same model, called once to read your app's LLM plumbing.
- **Judge** — every session's transcript is scored 0–100 by `anthropic/claude-haiku-4.5` (~$0.005/session). Disable per-run with `--disable-judge` if you only care about pass/fail + cost.

Additionally, OpenRouter is offered as one of the routers you can benchmark against. That part is optional — you can pick zero OR lanes on the Pick Routes screen. The three OR calls above happen regardless of which lanes you pick.

## Viewing the report

At the end of each run, canaryone writes a self-contained HTML report to:

```
<target>/.c1/runs/<runId>/report/index.html
```

Open it directly:

```bash
open .c1/runs/<runId>/report/index.html            # macOS
xdg-open .c1/runs/<runId>/report/index.html        # Linux
```

Some browsers (Chrome, notably) restrict `file://` local reads for images/fonts. If the report renders without logos or with broken drilldowns, serve the run directory over HTTP instead:

```bash
cd .c1/runs/<runId>/report
python3 -m http.server 8080
# then open http://localhost:8080
```

Or with Node:

```bash
npx serve .c1/runs/<runId>/report
```

The report is self-contained — copy the whole `report/` directory anywhere (email attachment, S3 bucket, GitHub Pages) and it will still render.

## What canaryone measures

Not just pass/fail. Every session gets a **trajectory score (0-100)** from a judge LLM (Claude Haiku 4.5) reading the transcript, composed of:

- **Action** (0-25, computed) — did the model actually call tools, or fake it?
- **Grounding** (0-25, judge) — did it use tool outputs to answer, or narrate?
- **Verification** (0-25, judge) — did it double-check numbers when they mattered?
- **Efficiency** (0-25, computed) — turn count vs task complexity.

The report's headline metric is **weighted $/pass** = `raw $/pass ÷ (judge / 100)`. This penalises "the test passed but the model narrated instead of grounding" — visible as ⚠ on scores under 50.

## Supported providers

| Router | Slug prefix | Auth env |
|---|---|---|
| **OpenRouter** *(required)* | `openrouter:` | `OPENROUTER_API_KEY` |
| **Vercel AI Gateway** | `vercel:` | `AI_GATEWAY_API_KEY` |
| **AWS Bedrock** *(gpt-oss only, OpenAI-compat endpoint)* | `bedrock:` | `AWS_BEARER_TOKEN_BEDROCK` + `AWS_REGION` |

Direct providers (OpenAI-compat endpoints, one lane per provider):

`direct:moonshot-intl`, `direct:moonshot-cn`, `direct:nebius`, `direct:fireworks`, `direct:together`, `direct:baseten`, `direct:groq`, `direct:deepseek`, `direct:cerebras`

Each direct provider ships with its native model catalog. OpenRouter and Vercel additionally expose their underlying host list (Baseten, Fireworks, Morph, Nebius, etc.) as separate variant lanes so you can compare *"the same model on the same underlying host, through two different gateways."*

## What's on your machine

Everything. `canaryone` runs a local HTTP proxy on an ephemeral port per lane, your test subprocess is spawned with `OPENAI_BASE_URL=http://localhost:<port>/v1`, and every request/response is logged to `<target>/.c1/runs/<runId>/traffic.jsonl` alongside a SQLite DB. **The only outbound traffic goes to the LLM providers you configured.**

- API keys live in `~/.c1/.env` (mode 0600), never sent anywhere except each provider's own endpoint.
- Provider catalogs cache in `~/.c1/*.json`.
- Per-run data in `<target>/.c1/runs/<runId>/`. Delete the whole tree to purge.

## Rough edges

- **AWS Bedrock** currently only supports gpt-oss models (via Amazon's OpenAI-compat endpoint). Claude / Llama / Mistral on Bedrock need a Converse-API translator that's not yet wired.
- **Direct-provider pricing** for cost math is hand-seeded (most direct providers don't expose pricing in their APIs). Kimi K3 and GLM 5.2 are covered across all shipped providers; other models fall back to `—` in the cost column and can be added by editing `src/proxy/providers.ts` or via the `scripts/backfill-cost.mjs` helper.
- **No streaming** on the proxy yet — every lane call is non-streaming. Streaming lands in the next milestone.
- **Session timeout** hard-coded to 6 minutes per session. Long-agent workloads on slow providers get killed; a `--session-timeout` flag is coming.
- **Judge** uses Claude Haiku 4.5 via OpenRouter. Costs ~$0.005 per session. Disable with `--disable-judge` if you only care about pass/fail + cost.

## Under the hood

- **Local HTTP proxy per lane** — canaryone-launched subprocess sees `http://localhost:<port>/v1` as its LLM base URL; the proxy rewrites `body.model` + routing headers for the specific route and forwards to the real provider.
- **Traffic log** — every request/response captured to `traffic.jsonl` at your target's `.c1/` directory. Full audit trail per session.
- **SQLite** — every session, step, judge tag, cost row in `<target>/.c1/db.sqlite`. Query it yourself.
- **HTML report** — auto-generated at end of run under `.c1/runs/<runId>/report/index.html`. Open in browser or serve with `python3 -m http.server`.
- **Cost accounting** — OpenRouter's `/generation?id=` used for per-request cost on OR lanes (cache-adjusted). Direct providers use hand-seeded prices from `providers.ts::DIRECT_PRICING`. Backfill helper: `node scripts/backfill-cost.mjs <db-path> <runId>`.

## Contributing

Bugs, provider adds, and reproducible failure patterns welcome as issues. PRs OK but coordinate first if you're touching the runner / lane proxy — those have live users.

## License

[MIT](./LICENSE)
