// HTML shell — a template literal joined from the section renderers.
// Structure:
//   Hero (always visible: title + meta + collapsible primer)
//   Tab nav (Report / Data inventory)
//   Tab panel "Report": sections 01..05
//   Tab panel "Data inventory": section 00 scaffold

import { STYLES } from './styles.js';
import { SCRIPTS } from './scripts.js';
import { faviconLinkTag } from './brand.js';

export interface RenderedSections {
  hero: string;
  report: string;      // sections 01..05 concatenated
  inventory: string;   // section 00 (data inventory)
}

export function shell(runId: string, targetDir: string, sections: RenderedSections): string {
  const title = escapeHtml(`Canary One · Run report · ${runId.slice(0, 8)}`);
  const generatedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="generator" content="canaryone report generator (phase 1)">
<meta name="generated-at" content="${generatedAt}">
<meta name="target-dir" content="${escapeAttr(targetDir)}">
${faviconLinkTag()}
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
${sections.hero}

<nav class="tabs" role="tablist">
  <button class="tab-btn active" data-tab="tab-report" role="tab">Report</button>
  <button class="tab-btn" data-tab="tab-inventory" role="tab">Data inventory <span class="muted" style="font-weight: 400;">· scaffold</span></button>
</nav>

<div class="tab-panel active" id="tab-report" role="tabpanel">
${sections.report}
</div>

<div class="tab-panel" id="tab-inventory" role="tabpanel">
${sections.inventory}
</div>
</div>
<script>${SCRIPTS}</script>
</body>
</html>`;
}

// ---------- shared HTML escape helpers ----------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s);
}
