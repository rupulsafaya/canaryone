import { defineConfig } from 'tsup';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import fg from 'fast-glob';

// Non-bundle mode: transpile each .ts/.tsx to .js and preserve src/ layout under
// dist/. This keeps `import.meta.url`-relative asset loading working (e.g.
// src/judge/haiku-r5.ts reads prompt-haiku-r5-local.md next to itself), and
// avoids paying to bundle React/Ink/deps we already list as runtime deps.
export default defineConfig({
  entry: ['src/**/*.{ts,tsx}'],
  format: 'esm',
  target: 'node22',
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
  bundle: false,
  splitting: false,
  clean: true,
  dts: false,
  sourcemap: false,
  shims: false,
  onSuccess: async () => {
    // Copy non-TS assets that source files read via import.meta.url.
    await mkdir('dist/judge', { recursive: true });
    await cp('src/judge/prompt-haiku-r5-local.md', 'dist/judge/prompt-haiku-r5-local.md');
    await mkdir('dist/report/assets/logos', { recursive: true });
    await cp('src/report/assets/logos', 'dist/report/assets/logos', { recursive: true });
    // tsup's non-bundle mode leaves `.ts`/`.tsx` extensions in relative import
    // specifiers. Node ESM won't resolve those against the emitted `.js`
    // files, so rewrite them here.
    const files = await fg('dist/**/*.js');
    const importRe = /(from\s*["'])(\.\.?\/[^"']+?)\.(tsx?)(["'])/g;
    for (const f of files) {
      const src = await readFile(f, 'utf8');
      const out = src.replace(importRe, '$1$2.js$4');
      if (out !== src) await writeFile(f, out);
    }
  },
});
