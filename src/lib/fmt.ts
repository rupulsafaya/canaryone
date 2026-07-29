// Shared formatters. Extracted so both the TUI (LiveProgress) and the
// headless run-summary printer render dollars/durations consistently.

// Format a $ amount at the right precision for whatever scale the value is at:
//   ≥ 1        → $1.23
//   ≥ 0.01     → $0.0123
//   ≥ 0.0001   → $0.000123
//   else       → $1.23e-7 (fallback for anything below $10^-4)
//   0          → $0
export function fmtDollars(v: number): string {
  if (!v) return '$0';
  const abs = Math.abs(v);
  if (abs >= 1)      return `$${v.toFixed(2)}`;
  if (abs >= 0.01)   return `$${v.toFixed(4)}`;
  if (abs >= 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toExponential(2)}`;
}

// Duration in seconds → "Ns" or "MmNNs".
export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}
