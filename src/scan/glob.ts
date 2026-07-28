import fg from 'fast-glob';
import path from 'node:path';

const TEST_EXT_GLOB = '**/*.{spec,test}.{ts,tsx,js,mjs,cjs,py}';

export function expandGlob(pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed) return trimmed;
  if (isGlob(trimmed)) return trimmed;
  const withSlash = trimmed.endsWith('/') ? trimmed : trimmed + '/';
  return withSlash + TEST_EXT_GLOB;
}

export function isGlob(pattern: string): boolean {
  return /[*?{}\[\]]/.test(pattern);
}

export interface MatchedFile {
  absolute: string;
  relative: string;
}

export async function matchFiles(targetDir: string, pattern: string): Promise<MatchedFile[]> {
  const expanded = expandGlob(pattern);
  const results = await fg(expanded, {
    cwd: targetDir,
    absolute: true,
    dot: false,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.venv/**'],
    suppressErrors: true,
  });
  return results
    .map((absolute) => ({ absolute, relative: path.relative(targetDir, absolute) }))
    .sort((a, b) => a.relative.localeCompare(b.relative));
}
