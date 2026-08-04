// CanaryOne's own brand marks, as opposed to the third-party provider logos in
// ./assets/logos. Two vectors, both cropped tight to their own bounds:
//
//   canaryone-lockup.svg  — symbol + "Canary One" wordmark, aspect 5.47:1.
//                           Letterforms are outlined paths, not <text>, so the
//                           mark survives screenshotting on machines that do
//                           not have the brand font installed.
//   canaryone-symbol.svg  — the bird/arrow symbol alone, aspect 1.06:1.
//
// Everything here inlines rather than linking, for the same reason the provider
// logos do: reports are routinely opened over file://, where Chrome refuses
// subresource loads and a linked asset fails silently.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets/brand');

// Native height of the symbol's viewBox, used to derive its render scale.
const SYMBOL_VIEWBOX_HEIGHT = 1631;

function read(file: string): string | null {
  try {
    return fs.readFileSync(path.join(BRAND_DIR, file), 'utf8').replace(/<\?xml[^?]*\?>/, '').trim();
  } catch {
    return null;
  }
}

// Figma exports carry generated ids like `clip0_1_2` or `8e8c1625e8`. Inlining
// two such SVGs into one document — or inlining one beside the Pareto chart,
// which defines its own `attractive-grad` gradient — makes those ids collide,
// and a collision silently reassigns a clip path to the wrong geometry. Rewrite
// every id to a per-call namespace so an inlined mark cannot capture or be
// captured by anything else on the page.
function namespaceIds(svg: string, ns: string): string {
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  let out = svg;
  for (const id of ids) {
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out
      .replace(new RegExp(`(\\sid=")${safe}(")`, 'g'), `$1${ns}-${id}$2`)
      .replace(new RegExp(`url\\(#${safe}\\)`, 'g'), `url(#${ns}-${id})`)
      .replace(new RegExp(`(\\sxlink:href=")#${safe}(")`, 'g'), `$1#${ns}-${id}$2`);
  }
  return out;
}

let lockupSeq = 0;

/**
 * The full lockup as inline SVG, scaled by height. Width follows from the
 * viewBox, so a 44px height yields roughly 241px of width — sized in
 * `renderTweetCard` to sit opposite a long model name without crowding it.
 */
export function lockupInline(heightPx: number, className = 'brand-mark'): string {
  const raw = read('canaryone-lockup.svg');
  if (!raw) return '';
  const ns = `c1b${++lockupSeq}`;
  return namespaceIds(raw, ns).replace(
    /<svg /,
    `<svg class="${className}" style="height:${heightPx}px;width:auto;display:block" `,
  );
}

/**
 * The symbol as a <g> transform, for embedding inside an existing SVG document.
 *
 * A nested <svg> would be the more obvious construction, but it introduces a
 * second `</svg>` inside the host document. The Pareto chart's PNG export walks
 * the DOM and so is unaffected, but anything that reaches for the chart with a
 * non-greedy `<svg …>.*?</svg>` match would silently truncate at the mark. A
 * <g> keeps the chart a single SVG element and costs only the scale arithmetic.
 */
export function symbolSvgNode(x: number, y: number, heightPx: number): string {
  const raw = read('canaryone-symbol.svg');
  if (!raw) return '';
  const pathOnly = raw.match(/<path[^>]*\/>/)?.[0];
  if (!pathOnly) return '';
  const scale = heightPx / SYMBOL_VIEWBOX_HEIGHT;
  return `<g transform="translate(${x} ${y}) scale(${scale.toFixed(6)})">${pathOnly}</g>`;
}

/**
 * The symbol as a `data:` URI for <link rel="icon">. SVG favicons are honoured
 * by every current browser, which is what lets the favicon stay a vector
 * instead of shipping a set of PNG rasters.
 */
export function faviconLinkTag(): string {
  const raw = read('canaryone-symbol.svg');
  if (!raw) return '';
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  return `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${b64}">`;
}
