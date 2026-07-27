export const FAMILY_COLOR: Record<string, string> = {
  anthropic: '#D97757',
  openai: '#a855f7',
  deepseek: '#00B7B5',
  google: '#4ade80',
  xai: '#ef4444',
  meta: '#3b82f6',
  qwen: '#c084fc',
  mistral: '#fb923c',
  cohere: '#f472b6',
  'z-ai': '#ec4899',
  other: '#94a3b8',
};

export const familyColor = (family: string) => FAMILY_COLOR[family] ?? FAMILY_COLOR.other;

export const CELL_COLOR = {
  queued: '#3f3f46',
  running: '#eab308',
  passed: '#22c55e',
  failed: '#ef4444',
  error: '#f97316',
};

export const CELL_GLYPH: Record<string, string> = {
  queued: '··',
  running: '▓▓',
  passed: '██',
  failed: '▒▒',
  error: '▚▚',
};

export const SCREEN_ACCENT = {
  onboarding: '#60a5fa',
  pickTasks: '#22d3ee',
  pickModels: '#22d3ee',
  confirm: '#a78bfa',
  liveProgress: '#eab308',
  report: '#22c55e',
};

export const changeColor = (pct: number) => (pct > 0 ? '#22c55e' : pct < 0 ? '#ef4444' : '#94a3b8');
