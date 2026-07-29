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

Requires **Node ≥ 22**. For now, clone + link locally (npm publish is pending):

```bash
git clone https://github.com/rupulsafaya/canaryone.git
cd canaryone && pnpm install
npm link                        # exposes `c1` on your PATH
```

Or run directly without linking:

```bash
./bin/c1.mjs                    # from the canaryone/ directory
pnpm dev                        # runs the TypeScript source via tsx
```

## First run (30 seconds)

Point `c1` at any repo whose test suite calls an LLM. The [`canaryone-demo`](https://github.com/rupulsafaya/canaryone-demo) repo is a reference test suite with a 4-tier difficulty ladder if you don't have one handy:

```bash
git clone https://github.com/rupulsafaya/canaryone-demo.git
cd canaryone-demo && pnpm install
c1                              # point at the current directory
```

You'll walk through:

1. **API keys** — paste tokens for the providers you want to compare. OpenRouter is required; everything else is optional.
2. **Onboarding** — canaryone reads your `package.json` / `pyproject.toml`, finds test files, detects your LLM SDK.
3. **Methodology check** — the runner env-swaps the LLM base URL, so it needs your target to read that from env (not a hardcoded URL). Fails loud on hardcoded configs.
4. **Pick routes** — search-first UI over every model your configured providers serve. `kimi k3` shows you Kimi K3 across all 10+ routes it exists on.
5. **Confirm & run** — **preflight probes** every picked lane with a 1-token request before spending real time on a run. Fails on billing/auth/model-access issues in ~5 seconds.
6. **Live progress** — see pass/fail per (lane, task) cell in real time.
7. **HTML report** — cost-per-pass, weighted $/pass, trajectory quality per lane, plus per-session drilldowns.

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
- **npm install** — canaryone isn't yet published to npm as a working package (the `0.0.0` on npm is a deprecated placeholder). For now, clone + `pnpm install` locally.

## Under the hood

- **Local HTTP proxy per lane** — canaryone-launched subprocess sees `http://localhost:<port>/v1` as its LLM base URL; the proxy rewrites `body.model` + routing headers for the specific route and forwards to the real provider.
- **Traffic log** — every request/response captured to `traffic.jsonl` at your target's `.c1/` directory. Full audit trail per session.
- **SQLite** — every session, step, judge tag, cost row in `<target>/.c1/db.sqlite`. Query it yourself.
- **HTML report** — auto-generated at end of run under `.c1/runs/<runId>/report/index.html`. Open in browser or serve with `python3 -m http.server`.
- **Cost accounting** — OpenRouter's `/generation?id=` used for per-request cost on OR lanes (cache-adjusted). Direct providers use hand-seeded prices from `providers.ts::DIRECT_PRICING`. Backfill helper: `node scripts/backfill-cost.mjs <db-path> <runId>`.

## Companion repos

- **[canaryone-demo](https://github.com/rupulsafaya/canaryone-demo)** — reference agent test suite (4-tier difficulty ladder over a mini SaaS analytics fixture). Copy this shape for your own tests.
- **[canaryone-cloud](https://github.com/rupulsafaya/canaryone-cloud)** — hosted showcase dashboard (feature-frozen companion) at [canaryone-theta.vercel.app](https://canaryone-theta.vercel.app).

## Contributing

Bugs, provider adds, and reproducible failure patterns welcome as issues. PRs OK but coordinate first if you're touching the runner / lane proxy — those have live users.

## License

[MIT](./LICENSE)
