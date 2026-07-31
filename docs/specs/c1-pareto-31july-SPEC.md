# canaryone report — SPEC: Pareto chart + per-eval breakdown

**Status:** proposed 2026-07-31. Owner: **Bhaskar** (report).
**Companion spec:** [`c1-direct-providers-31july-SPEC.md`](./c1-direct-providers-31july-SPEC.md) — provider expansion (ships AFTER this).
**Reading order:** [`c1-report-29july-SPEC.md`](./c1-report-29july-SPEC.md) §1–§4 → this doc.
**Trigger:** Hao Liu's DeepSeek-V4-Flash-0731 cost-vs-quality scatter (2026-07-31) — the "Artificial Analysis" chart shape. We want the same visual grammar, but the dots are **the developer's own workload**, not academic benchmarks.

---

## 1. Purpose

Two new sections in the single-file HTML report at `.c1/runs/<runId>/report/index.html`:

1. **Pareto chart** — cost-vs-quality scatter across all Destinations in the run, with a global Pareto frontier drawn in canary yellow. Lead copy above the chart:

   > *Artificial Analysis tells you which model wins on academic benchmarks. This chart tells you which wins on YOUR workload.*

2. **Per-eval breakdown** — small-multiples: one mini scatter per test eval (task), so a reader can see whether the aggregate winner won every eval or was carried by one.

Both sections render **inline in `index.html`** — no standalone pareto.html sibling. Each chart in the report gets an **export-to-PNG button** so any single chart can be screenshotted for sharing.

**This spec ships first.** Data already exists from prior canaryone-demo runs (via OR/Vercel routes). The chart machinery is provider-agnostic and lands independently of the direct-provider expansion in [`c1-direct-providers-31july-SPEC.md`](./c1-direct-providers-31july-SPEC.md).

## 2. Non-goals

- New judge or trajectory scoring — judge is off-limits ([`c1-launch-29july-SPEC.md`](./c1-launch-29july-SPEC.md) locked it).
- Chart libraries. Pure inline SVG + a small vanilla-JS island for the toggle and export button. Matches [`src/report/sections/tweet-card.ts`](../../src/report/sections/tweet-card.ts).
- Standalone `pareto.html` — dropped. Consolidate on `index.html`. Export button covers the sharable-image use case.
- Cross-run comparison / trend view.
- Live-updating during a run.
- Modifying tweet card or leaderboard sections — they ship as-is.

## 3. Invariants

1. **Read-only from existing data sources.** Same contract as the parent report spec: SQLite + traffic.jsonl only. No new tables, no schema migrations.
2. **Locked nomenclature** (per [`reference_canaryone_nomenclature.md`](../nomenclature.md) if present; otherwise memory): Model / Router / Provider / Variant / Destination. Chart labels use these exact terms.
3. **Pure HTML + CSS + inline SVG.** One small `<script>` island for the (a) distribution-mode checkbox toggle, (b) SVG→PNG export button. No external libs, no CDN.
4. **Graceful degradation.** If fewer than 3 Destinations have `avgTraj != null && passed > 0`, the Pareto section is **skipped** (leaderboard/heatmap still render). Log a note in the report header.
5. **Deterministic bytes** modulo timestamps.
6. **Does not break** existing `index.html` render. The new sections append after the existing leaderboard/heatmap; they do not restructure the shell in [`src/report/template.ts`](../../src/report/template.ts).

---

## 4. Data contract

Consumes existing shapes from [`src/report/data.ts`](../../src/report/data.ts). Nothing new in SQLite.

### 4.1 Per-Destination aggregate (Pareto dots)

One dot per Destination. Source: `LaneRollup` from `computeLaneRollups(data)`.

```
Dot {
  destSlug:            string   // e.g. "openrouter:openai/gpt-5.6-luna"
  modelSlug:           string   // e.g. "openai/gpt-5.6-luna"
  router:              string   // "openrouter" | "vercel" | "direct:xxx" | ...
  displayName:         string   // "GPT-5.6 Luna via OR"
  x_weighted:          number   // dollarsPerPass = spend/passed   (pass-rate-weighted, default axis)
  x_raw:               number   // spend/attempted                 (toggle)
  y_trajectory:        number   // avgTraj (0-100)
  passed:              number
  attempted:           number
  // Distribution (used only when the "show distribution" checkbox is on):
  x_min, x_max:        number   // min / max per-repeat cost-per-pass across the lane's repeats
  y_min, y_max:        number   // min / max per-repeat trajectory across the lane's repeats
}
```

**Metric definitions (fix in code, document in report footer):**

- **Weighted $/pass (default X):** `spend / passed`. This is pass-rate weighted: a lane that fails 40 % of the time costs ~1.67× its per-attempt sticker. Formula: `$/attempt ÷ pass_rate = (spend/attempted) / (passed/attempted) = spend/passed`. (This is exactly the existing `LaneRollup.dollarsPerPass` field — reuse it.)
- **Raw $/pass (toggle X):** `spend / attempted` — the "sticker cost per attempt." Renamed conceptually from the current `LaneRollup.weightedDollarsPerPass` (which is trajectory-weighted; **not** what we want here — see §11 open questions).
- **Trajectory (Y):** `LaneRollup.avgTraj` — mean judge trajectory score across all repeats for that Destination.

**Excluded from the chart:**
- Destinations with `passed === 0` (no valid `dollarsPerPass`).
- Destinations with `avgTraj === null` (no judge score).
- Both excluded silently; log the count in the report header ("2 destinations excluded from Pareto: no successful passes").

### 4.2 Per-repeat distribution (for the checkbox mode)

The chart's "show distribution" checkbox reveals both-axis whiskers. Source: the same `sessions` table, grouped by `(destination_slug, repeat_ix)`.

Per-repeat cost-per-pass for a Destination × repeat:
```
sum(cost_usd where repeat=r AND status=complete) / count(status=complete where repeat=r)
```
If a repeat has zero passes, drop it from the whisker calculation for that Destination (don't NaN-explode).

Per-repeat trajectory: mean `trajectory_score` across all sessions in that `(destination_slug, repeat_ix)` group.

Whiskers = `[min, max]` across repeats on each axis. No median-line-inside-box — that's the dot itself. See §6.2 for busyness mitigation.

### 4.3 Per-eval breakdown (small-multiples)

For each `task_id` in the run, compute a per-Destination dot restricted to that task's sessions. Source: `LaneRollup.perTask` (already exists; already has `attempted`, `passed`, `spend`).

Each mini chart = same axes as the main Pareto chart, restricted to one task.

---

## 5. UI spec — Pareto chart

### 5.1 Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Best Model / Route analysis for canaryone-demo @ a3f9c1e   │
│  · 2026-07-31                                        [export]│
├─────────────────────────────────────────────────────────────┤
│  Artificial Analysis tells you which model wins on academic │
│  benchmarks. This chart tells you which wins on YOUR        │
│  workload.                                                  │
│                                                             │
│  [ ] show per-repeat distribution     x: (•) weighted  ( ) raw │
│                                                             │
│  ┌──────────────────────────────────────────────────┐       │
│  │  100 ┤                                           │       │
│  │      │       ● Claude Opus 5                     │       │
│  │      │      ╱                                    │       │
│  │      │  ● ─┘  (canary-yellow frontier line)      │       │
│  │      │ ╱                                         │       │
│  │      │● GPT-5.6 Luna                             │       │
│  │      │            ● DeepSeek V4 Flash            │       │
│  │      │ (muted dominated dots below the line)     │       │
│  │      │                                           │       │
│  │   0  └───────────────────────────────────────    │       │
│  │       $0.001   $0.01   $0.10   $1.00  (log)      │       │
│  └──────────────────────────────────────────────────┘       │
│                                                             │
│  ▸ Pareto-optimal Destinations (5): …                       │
│  ▸ Dominated Destinations (7): …                            │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Axes

- **X:** log-scale. Cost per pass in USD. Default = weighted (§4.1). Toggle to raw via radio pair beside the axis.
- **Y:** linear. Trajectory score, 0–100. Fixed range regardless of data (so the chart looks the same across runs).
- **Ticks:**
  - X: log ticks at $0.001, $0.01, $0.10, $1.00 (auto-extend to $10 if any dot exceeds $1).
  - Y: 0, 25, 50, 75, 100.
- **Gridlines:** faint canary-tint horizontal at each Y tick; vertical at each X major tick.

### 5.3 Attractive quadrant

Shade the region **above the Pareto frontier** with a faint canary tint (~8% opacity). This is the "you'd want to be here" zone. The shading is drawn from the piecewise frontier line up to the top edge of the plot area — not a rectangular quadrant. Rationale: AA's rectangular quadrant is a heuristic; ours is exact because we have the actual frontier.

### 5.4 Frontier line

- Compute `computeParetoFrontier(dots)` — see §7.
- Draw a **canary-yellow** stroke (`#f5c518` per canaryone brand palette — verify against [canaryone-web](../../../canaryone-web) tokens) at ~2.5px, connecting frontier points in ascending X order.
- Frontier dots rendered in canary yellow fill + dark stroke; **all other dots muted** (~40% opacity, neutral gray fill).
- No single "winner" dot highlighted differently — the frontier line IS the answer (per user decision 2026-07-31).

### 5.5 Dot styling

- Radius: 6px baseline, 8px for frontier dots.
- Fill: provider-coded color (see §5.7). Frontier dots override with canary yellow.
- Label: model short name (e.g. "GPT-5.6 Luna"), rendered inline right-of-dot with an offset that avoids collisions with the frontier line. Font: same monospace stack as the rest of the report.
- Router variant: if two Destinations share a model slug (e.g. `openai/gpt-5.6-luna` via OR and direct), append the router in parentheses: `GPT-5.6 Luna (direct)`.
- Hover: show a tooltip with `displayName · $X.XX / pass · trajectory Y · N repeats`. Reuse the tweet-card provider logo (`src/report/assets/logos/`) inline in the tooltip.

### 5.6 Distribution mode (checkbox)

- Default: **off**. Dots are median-only (matches AA reference).
- When on: for each dot, draw horizontal whisker `[x_min, x_max]` at trajectory=y, and vertical whisker `[y_min, y_max]` at cost=x. Line weight 1px, muted color = dot color at 50% opacity.
- **Busyness mitigation:** 12 dots × 2-axis whiskers is visually noisy. Two guardrails:
  1. When distribution is on, dim non-frontier dots' whiskers further (25% opacity) so the frontier's variance still reads.
  2. Consider an interactive filter (hover over a legend entry to solo that provider's whiskers). Open question — see §11.

### 5.7 Provider coloring

Reuse the existing tweet-card logo files under [`src/report/assets/logos/`](../../src/report/assets/logos/). Extract or hand-code a canonical color per provider:

| Provider   | Color hint | Existing asset                    |
|------------|-----------|-----------------------------------|
| Baseten    | (from svg)| Baseten_Symbol-6.svg              |
| Fireworks  | (from svg)| fireworks-ai-icon.svg             |
| Kimi       | (from png)| kimi-icon-rounded-corner.png      |
| Nebius     | (from svg)| NEBIUS-color.svg                  |
| (rest)     | seed neutral | fallback gray until logo added |

New logos for OpenAI / Anthropic / DeepSeek / xAI are added in the companion spec ([`c1-direct-providers-31july-SPEC.md`](./c1-direct-providers-31july-SPEC.md) §6). This spec ships without them; missing-logo Destinations render with a neutral fill.

### 5.8 Header

- H2 text: `Best Model / Route analysis for <repoName> @ <shortSha> · <isoDate>`
- Bindings:
  - `<repoName>` = `basename(gitRepoRoot(cwd))`, e.g. `canaryone-demo`. Fall back to `basename(targetDir)` if not a git repo.
  - `<shortSha>` = first 7 chars of `git rev-parse HEAD` in `targetDir`. Fall back to `""` (drop the `@ ...` fragment) if not a git repo.
  - `<isoDate>` = the run's `finished_at` date in ISO format (e.g. `2026-07-31`).
- All three read from the existing `RunData.meta` if present; the report generator already resolves this for the shell header — reuse the same lookup.

### 5.9 Export button

- Top-right of each chart section (Pareto + each per-eval mini-chart).
- Label: `↓ PNG`.
- Behavior: on click, serialize the chart's inline `<svg>` → draw to `<canvas>` → export as PNG via `canvas.toBlob()` → trigger a download of `<repoName>-<shortSha>-<sectionName>.png`.
- ~30 lines of vanilla JS. Reference implementation lives in `src/report/scripts.ts` (new function `wireExportButtons()`).
- No dependency on the DOM state of the checkboxes — export captures whatever's currently rendered (so if distribution is on, the PNG shows whiskers).

---

## 6. UI spec — per-eval breakdown

### 6.1 Layout

A row of mini scatter charts, one per `task_id`. If the run has 4 tasks, render 2×2 (or 4×1 on wide viewports). Each mini chart:

- ~360px × 240px.
- Same axes as the main chart (log-scale X, linear Y 0–100).
- Fewer axis labels (just start/end ticks) — the main chart is the reference.
- Same per-provider colors, same frontier logic, but computed on the restricted per-task data.
- Task-name headline: `<task_id> · <shortSummary>` where `shortSummary` comes from `tasks_meta.summary`.
- Export button per mini chart.

### 6.2 Degradation

- If any task has fewer than 3 dots, skip its mini chart (render a "not enough data for this task" placeholder).
- If ALL tasks have <3 dots, skip the entire per-eval section.

---

## 7. `computeParetoFrontier` — pure function + tests

**Signature:**
```ts
export function computeParetoFrontier(dots: Dot[]): Dot[]
```

**Semantics:**
A dot `d` is on the frontier iff no other dot dominates it. Dot `a` dominates `b` iff:
```
a.x <= b.x  AND  a.y >= b.y  AND  (a.x < b.x  OR  a.y > b.y)
```
(lower cost and equal-or-higher quality, with at least one strict inequality).

Returned frontier is sorted by X ascending. Ties: if two dots have identical `(x, y)`, both are included (rendered stacked; the label collision handler nudges one).

**Tests** — `tests/pareto.test.mjs`:
- Empty input → `[]`.
- One dot → `[dot]`.
- Two dots, one dominates → `[winner]`.
- Two dots, neither dominates → both in frontier, sorted by X.
- Three-dot chain a<b<c dominated by c → `[c]`.
- Real fixture from canaryone-demo — golden frontier baseline.
- Ties on X: both retained, sorted stably.
- Ties on Y with different X: cheaper one dominates.

Location: [`src/report/pareto.ts`](../../src/report/pareto.ts) (new).

---

## 8. Files to touch (verified against repo state 2026-07-31)

**Existing files (edit):**
- [`src/report/generate.ts`](../../src/report/generate.ts) (46 loc) — call new section renderers, wire export scripts.
- [`src/report/data.ts`](../../src/report/data.ts) (524 loc) — add `computeDotsFromLanes(lanes, data)` returning `Dot[]`; expose per-repeat distribution rollup.
- [`src/report/sections/`](../../src/report/sections/) — add `pareto.ts` (main chart) and `per-eval.ts` (small-multiples).
- [`src/report/scripts.ts`](../../src/report/scripts.ts) — add `wireExportButtons()` and `wireDistributionToggle()`.
- [`src/report/styles.ts`](../../src/report/styles.ts) — add `.c1-pareto-*` selectors, canary-yellow token if not already defined.
- [`src/report/template.ts`](../../src/report/template.ts) — verify anchor points; extend if needed.

**New files:**
- [`src/report/pareto.ts`](../../src/report/pareto.ts) — pure `computeParetoFrontier(dots)` + `computeDotsFromLanes(lanes)`.
- [`src/report/sections/pareto.ts`](../../src/report/sections/pareto.ts) — main chart renderer (returns HTML string).
- [`src/report/sections/per-eval.ts`](../../src/report/sections/per-eval.ts) — small-multiples renderer.
- [`tests/pareto.test.mjs`](../../tests/pareto.test.mjs) — see §7.

**Do NOT touch:**
- [`src/report/sections/tweet-card.ts`](../../src/report/sections/tweet-card.ts) — shipped.
- Judge scoring — off-limits.
- SQLite schema.
- `~/.c1/.env` loading path.

---

## 9. Milestones (each = one commit on branch)

1. **Add `computeParetoFrontier(dots)` + tests.** Pure function, no report integration yet. Merge criterion: `tests/pareto.test.mjs` green.
2. **Add `computeDotsFromLanes(lanes, data)` in `src/report/data.ts` + tests.** Median + per-repeat distribution rollup. Covers the exclusion rules in §4.1.
3. **Render the Pareto chart section inline in `index.html`.** No distribution toggle yet, no export button — just the static scatter + frontier line + attractive-quadrant shading. Verify visually on a saved canaryone-demo run.
4. **Add distribution-mode checkbox.** Wire the vanilla-JS island in `scripts.ts`. Verify busyness with a real 8+ dot run.
5. **Add x-axis metric toggle (weighted / raw).** Two radios rerender the dots + frontier client-side using pre-embedded `x_weighted` + `x_raw` values.
6. **Add per-eval small-multiples section.** Reuse the same renderer, restricted to per-task data. Handle degradation (§6.2).
7. **Add export-to-PNG buttons.** SVG→canvas→blob download. Verify PNGs open in Preview / render on Twitter.
8. **End-to-end on canaryone-demo.** Regenerate the report from the last shipped run's SQLite. Confirm 8–12 dots, meaningful frontier, no visual regressions in existing sections. Ship.

Milestones 1–3 can be a single PR; the rest are independent commits on the same branch.

---

## 10. Kill criteria

- **<3 valid Destinations after §4.1 exclusions:** skip the Pareto section entirely. Leaderboard + heatmap still render. Log a note in the header.
- **All Destinations excluded (no passes anywhere):** skip both sections. The rest of the report still works.
- **Missing `avgTraj`** on any Destination: exclude that Destination, don't fake it.
- **Chart libraries proposed:** stop. Reroute via inline SVG. This is a hard-line invariant.
- **Standalone pareto.html sibling proposed:** stop. Consolidate on index.html per user decision 2026-07-31.
- **Judge changes proposed:** stop. Judge is off-limits.

---

## 11. Open questions (spec-time)

1. **Canary yellow token.** Confirm exact hex from canaryone-web tokens; §5.4 uses `#f5c518` as a placeholder. Verify against [canaryone-web/](../../../canaryone-web/) before Milestone 3.
2. **Distribution-mode busyness at 12+ dots.** §5.6 has two guardrails but they may not be enough. Fallback plan if a test viewer says "unreadable": add a per-provider legend-solo interaction (click a provider in the legend, only that provider's whiskers stay visible). Decide at Milestone 4.
3. **Metric naming collision with existing `LaneRollup.weightedDollarsPerPass`.** The existing field is *trajectory-weighted*, not pass-rate-weighted. This spec redefines "weighted" as pass-rate-weighted (which equals the existing `LaneRollup.dollarsPerPass`). Two options:
   - **(a) Rename the existing field** `weightedDollarsPerPass` → `trajectoryWeightedDollarsPerPass` and expose the concept through a separate view. Cleanest, more churn.
   - **(b) Just alias in the chart section.** The chart uses `x_weighted = LaneRollup.dollarsPerPass`, `x_raw = LaneRollup.spend / attempted`, and does NOT expose the existing trajectory-weighted metric on the X axis at all. Least churn.
   Recommend (b). Confirm at Milestone 2.
4. **Log-scale zero handling.** If any Destination has `dollarsPerPass < $0.0001`, does the log axis clamp or crop? Decide the floor at Milestone 3.
5. **PNG export DPI / dimensions.** What's the target width when downloaded? 1200px feels right for X sharing; 2400px for high-DPI. Decide at Milestone 7.

---

## 12. Verification (before shipping)

- Regenerate the report from a shipped canaryone-demo run (the Baseten/Kimi K3 launch data).
- Confirm 5+ Destinations render as dots, frontier line covers the non-dominated set, attractive quadrant shades correctly.
- Open the PNG export — the image looks like the tweet card equivalent.
- Confirm the per-eval small-multiples render with 4 evals × 5+ Destinations without label collisions.
- Diff `index.html` byte size before / after: should stay well under 1 MB.
- Load the file offline (disable network in devtools): everything still renders.

Once Part 2 ([`c1-direct-providers-31july-SPEC.md`](./c1-direct-providers-31july-SPEC.md)) lands, re-run canaryone-demo with 5+ direct providers and confirm the chart tells the intended story (a surprise winner on the Pareto frontier for the specific workload). That re-run is the shipping moment for the Hao Liu reply.
