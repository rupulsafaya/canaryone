import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

// Follow the focused row: scroll the window so the focused index stays visible.
// visibleRows: how many rows the caller's content area can display.
// focusedIndex: index into the caller's rows[] (post-heterogeneous, including header rows).
// Returns [start, end) slice + counts of clipped rows above/below (for the scroll indicators).
export function useScrollWindow(itemCount: number, focusedIndex: number, visibleRows: number) {
  const [windowStart, setWindowStart] = useState(0);

  useEffect(() => {
    if (focusedIndex < 0 || visibleRows <= 0) return;
    setWindowStart((prev) => {
      let next = prev;
      if (focusedIndex < prev) next = focusedIndex;
      else if (focusedIndex >= prev + visibleRows) next = focusedIndex - visibleRows + 1;
      const maxStart = Math.max(0, itemCount - visibleRows);
      return Math.max(0, Math.min(next, maxStart));
    });
  }, [focusedIndex, visibleRows, itemCount]);

  const windowEnd = Math.min(itemCount, windowStart + visibleRows);
  return {
    windowStart,
    windowEnd,
    overflowAbove: windowStart,
    overflowBelow: Math.max(0, itemCount - windowEnd),
  };
}

// Terminal-height-aware helper. Returns [cols, rows]; caller subtracts chrome from rows.
export function useTerminalDimensions(): [number, number] {
  const { stdout } = useStdout();
  const [dims, setDims] = useState<[number, number]>([stdout.columns ?? 100, stdout.rows ?? 30]);
  useEffect(() => {
    const handler = () => setDims([stdout.columns ?? 100, stdout.rows ?? 30]);
    stdout.on('resize', handler);
    return () => { stdout.off('resize', handler); };
  }, [stdout]);
  return dims;
}
