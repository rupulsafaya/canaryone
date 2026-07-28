import React from 'react';
import { Box, Text } from 'ink';

// Small indicator rendered above/below a windowed list to show clipped rows.
export function ScrollHint({ side, count }: { side: 'above' | 'below'; count: number }) {
  if (count <= 0) return null;
  return (
    <Box flexShrink={0}>
      <Text color="#64748b" dimColor>
        {side === 'above' ? '▲ ' : '▼ '}{count} more {side} · use ↑↓ to scroll
      </Text>
    </Box>
  );
}
