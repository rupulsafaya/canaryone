import React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';

type Props = {
  title: string;
  subtitle?: string;
  accent: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

export function Frame({ title, subtitle, accent, children, footer }: Props) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box>
          <Gradient name="pastel">
            <Text bold>canaryone </Text>
          </Gradient>
          <Text color={accent} bold>· {title}</Text>
        </Box>
        {subtitle && <Text color="gray">{subtitle}</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
      {footer && (
        <Box marginTop={1} borderStyle="single" borderColor="gray" borderBottom={false} borderLeft={false} borderRight={false}>
          <Box paddingTop={1}>{footer}</Box>
        </Box>
      )}
    </Box>
  );
}
