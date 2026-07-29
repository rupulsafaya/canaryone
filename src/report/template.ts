// HTML shell — a template literal joined from the section renderers.
// Section order:
//   Hero (metadata + primer)
//   00 Data inventory (scaffold, collapsed by default)
//   01..05 stubs (phase 1)

import { STYLES } from './styles.js';
import { SCRIPTS } from './scripts.js';

export interface RenderedSections {
  hero: string;
  inventory: string;
  stubs: string;
}

export function shell(runId: string, targetDir: string, sections: RenderedSections): string {
  const title = escapeHtml(`canaryone · Run report · ${runId.slice(0, 8)}`);
  const generatedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="generator" content="canaryone report generator (phase 0)">
<meta name="generated-at" content="${generatedAt}">
<meta name="target-dir" content="${escapeAttr(targetDir)}">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
${sections.hero}
${sections.inventory}
${sections.stubs}
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
