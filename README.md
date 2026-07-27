# canaryone

Local agent-testing CLI. Point at your agent codebase, benchmark against N models on **your** tasks. Nothing leaves the machine.

- **Binary:** `c1`
- **Install (planned):** `npx canaryone` / `npm i -g canaryone`
- **Companion (hosted showcase):** [canaryone-cloud](https://github.com/rupulsafaya/canaryone-cloud) — the OR-Broadcast dashboard at [canaryone-theta.vercel.app](https://canaryone-theta.vercel.app)

## Status

Design phase. See [c1-local-SPEC-2707-v0.md](./c1-local-SPEC-2707-v0.md) for the v0 build spec.

## Positioning

You don't know which model runs your agent best on your code. External benchmarks measure someone else's tasks. Routers measure latency. FinOps tools measure spend. Nobody measures **cost per completed outcome, on your codebase, across every route available to you.**

`canaryone` runs your regression tests against N models locally, ranks them by cost-per-passing-outcome, hands you the numbers. No cloud. No account. No data leaves the box.
