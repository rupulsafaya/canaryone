import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import Gradient from 'ink-gradient';

type Props = {
  title: string;
  subtitle?: string;
  accent: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

// Snapshot terminal dimensions and update on resize so the frame occupies a stable region.
function useStdoutDimensions(): [number, number] {
  const { stdout } = useStdout();
  const [dims, setDims] = useState<[number, number]>([stdout.columns ?? 100, stdout.rows ?? 30]);
  useEffect(() => {
    const handler = () => setDims([stdout.columns ?? 100, stdout.rows ?? 30]);
    stdout.on('resize', handler);
    return () => { stdout.off('resize', handler); };
  }, [stdout]);
  return dims;
}

export function Frame({ title, subtitle, accent, children, footer }: Props) {
  const [cols, rows] = useStdoutDimensions();
  // Reserve full terminal region; clip via flexShrink to prevent scroll-growth.
  const frameHeight = Math.max(20, rows - 1);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      height={frameHeight}
      width={Math.min(cols, 200)}
    >
      <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <Box>
          <Gradient name="pastel">
            <Text bold>canaryone </Text>
          </Gradient>
          <Text color={accent} bold>· {title}</Text>
        </Box>
        {subtitle ? <Text color="gray">{subtitle}</Text> : <Text> </Text>}
      </Box>
      <Box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden">
        {children}
      </Box>
      {footer && (
        <Box flexDirection="column" flexShrink={0} borderStyle="single" borderColor="gray" borderBottom={false} borderLeft={false} borderRight={false}>
          <Box paddingTop={0}>{footer}</Box>
        </Box>
      )}
    </Box>
  );
}
