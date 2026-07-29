// Embedded CSS. Light theme, adapted from
// ~/Documents/GitHub/product0/reports/oc-deepseek-2026-07-17/index.html
// so canaryone reports feel like part of the same product family.

export const STYLES = `
:root {
  --bg: #ffffff;
  --panel: #fafafa;
  --panel-strong: #f3f4f6;
  --ink: #1a1a1a;
  --muted: #6b7280;
  --line: #e5e7eb;
  --line-strong: #d1d5db;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;

  --winner: #16a34a;
  --winner-bg: #dcfce7;
  --winner-ink: #14532d;
  --safe: #16a34a;
  --safe-bg: #dcfce7;
  --marginal: #ca8a04;
  --marginal-bg: #fef9c3;
  --regression: #dc2626;
  --regression-bg: #fee2e2;
  --unusable-bg: #f3f4f6;
  --unusable-ink: #6b7280;
  --unreachable-bg: #fef2f2;
  --unreachable-ink: #991b1b;

  --router-openrouter: #22d3ee;
  --router-direct: #7c3aed;
  --router-vercel: #0891b2;
  --router-cloudflare: #f97316;

  --family-anthropic: #D97757;
  --family-openai: #a855f7;
  --family-google: #4ade80;
  --family-deepseek: #00B7B5;
  --family-moonshot: #e879f9;
  --family-other: #64748b;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--ink);
  background: var(--bg);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1240px; margin: 0 auto; padding: 32px 24px 80px; }

/* Headings */
h1, h2, h3, h4 { margin: 0; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 28px; line-height: 1.2; }
h2 {
  font-size: 20px; margin-top: 48px; padding-top: 24px;
  border-top: 1px solid var(--line);
}
h2 .sec-num {
  color: var(--muted); font-weight: 500; margin-right: 8px;
  font-variant-numeric: tabular-nums;
  font-family: "SF Mono", ui-monospace, Consolas, monospace;
  font-size: 18px;
}
h3 { font-size: 15px; margin-top: 20px; margin-bottom: 8px; }
h4 { font-size: 13px; margin-top: 14px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }

p { margin: 8px 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

code, .mono {
  font-family: "SF Mono", ui-monospace, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
}
code { background: var(--panel); padding: 1px 4px; border-radius: 3px; }
.muted { color: var(--muted); }
.dim   { color: var(--muted); font-style: italic; }
.tab   { font-variant-numeric: tabular-nums; }

/* Hero */
.hero-sub { color: var(--muted); font-size: 14px; margin-top: 6px; margin-bottom: 14px; }
.metric-primer {
  background: #f8fafc;
  border: 1px solid #cbd5e1;
  border-left: 4px solid var(--accent);
  padding: 14px 18px;
  border-radius: 6px;
  margin: 20px 0 10px;
  font-size: 14px;
  line-height: 1.55;
  max-width: 980px;
}
.metric-primer strong { color: var(--ink); }
.metric-primer .formula {
  display: block;
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 13px;
  background: white;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 12px;
  margin-top: 8px;
  color: #334155;
}

/* Metadata table (hero) */
.meta-table {
  border-collapse: collapse;
  margin-top: 4px;
  font-size: 13.5px;
}
.meta-table td { padding: 3px 20px 3px 0; vertical-align: top; }
.meta-table td.label { color: var(--muted); width: 130px; }

/* Details / explainers */
details.explain {
  margin: 12px 0 8px;
  padding: 10px 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.55;
}
details.explain > summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  color: var(--ink);
  padding: 2px 0;
  outline: none;
}
details.explain > summary::marker { color: var(--muted); }
details.explain .explain-body { margin-top: 8px; color: var(--ink); }
details.explain dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 6px 0 0; }
details.explain dt { color: var(--muted); font-family: "SF Mono", ui-monospace, monospace; font-size: 12px; }
details.explain dd { margin: 0; font-size: 13px; }

/* Section stubs (phase 1 placeholders) */
section.stub {
  opacity: 0.5;
}
section.stub .todo {
  background: var(--panel);
  border: 1px dashed var(--line-strong);
  padding: 20px;
  border-radius: 6px;
  text-align: center;
  color: var(--muted);
  font-size: 13.5px;
}

/* Layer-1 catalog */
.catalog {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  margin-top: 8px;
}
.catalog-row {
  display: grid;
  grid-template-columns: 180px 100px 1fr;
  gap: 12px;
  padding: 8px 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 13px;
  align-items: baseline;
}
.catalog-row .table-name { font-weight: 600; font-family: "SF Mono", ui-monospace, monospace; }
.catalog-row .row-count  { color: var(--muted); font-variant-numeric: tabular-nums; }
.catalog-row .columns    { color: var(--muted); font-family: "SF Mono", ui-monospace, monospace; font-size: 12px; word-break: break-all; }

/* Layer-2 distribution tables */
.dist-block { margin-top: 18px; }
.dist-block > h4 { margin-bottom: 6px; }
table.dist {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  border: 1px solid var(--line);
}
table.dist th, table.dist td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
table.dist th {
  background: var(--panel-strong);
  color: var(--muted);
  font-weight: 500;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
table.dist td.col-name { font-family: "SF Mono", ui-monospace, monospace; font-size: 12px; font-weight: 500; }
table.dist td.col-dist { color: var(--ink); }
table.dist td.col-sample { color: var(--muted); font-family: "SF Mono", ui-monospace, monospace; font-size: 11.5px; }
table.dist tr.dead td { color: var(--muted); }
table.dist tr.dead td.col-dist::after {
  content: " (constant · dead field)";
  color: var(--marginal);
  font-size: 11px;
  font-style: italic;
}
.pill {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--panel-strong);
  color: var(--ink);
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 11.5px;
  margin-right: 4px;
}
.pill .n { color: var(--muted); }

/* Layer-3 JSON tree */
.json-tree {
  font-family: "SF Mono", ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 12px 16px;
  margin-top: 10px;
}
.json-key {
  display: grid;
  grid-template-columns: minmax(220px, max-content) 1fr;
  gap: 12px;
  padding: 1px 0;
}
.json-key .key-path { color: var(--ink); }
.json-key .key-info { color: var(--muted); }
.json-key .type-string   { color: #0f766e; }
.json-key .type-number   { color: #0369a1; }
.json-key .type-boolean  { color: #6d28d9; }
.json-key .type-array    { color: #7c3aed; }
.json-key .type-object   { color: #64748b; }
.json-key .type-null     { color: #b91c1c; }

/* Layer-4 metrics panel */
.metrics-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-top: 12px;
}
.metrics-col {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 14px 18px;
  font-size: 13px;
  line-height: 1.7;
}
.metrics-col h4 { margin-top: 0; }
.metrics-col table { border-collapse: collapse; width: 100%; }
.metrics-col td { padding: 2px 0; vertical-align: top; }
.metrics-col td.label { color: var(--muted); width: 40%; }
.metrics-col.possible li { color: var(--muted); font-size: 13px; }
.metrics-col.possible ul { margin: 6px 0 0; padding-left: 20px; }
@media (max-width: 900px) {
  .metrics-grid { grid-template-columns: 1fr; }
}

/* Traffic kinds */
.kind-bar {
  display: flex; gap: 16px; margin-top: 8px; flex-wrap: wrap;
  font-size: 13px;
}
.kind-bar .kind {
  padding: 2px 8px;
  background: var(--panel-strong);
  border-radius: 4px;
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 12px;
}
`;
