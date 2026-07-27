import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../state/store.js';
import { ENV_HAS_OR_KEY, OR_CREDITS_REMAINING, TOP_MODELS, TASKS } from '../data/fixtures.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

export function Onboarding() {
  const goTo = useStore((s) => s.goTo);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (step >= 4) return;
    const t = setTimeout(() => setStep((s) => s + 1), step === 0 ? 400 : 800);
    return () => clearTimeout(t);
  }, [step]);

  useInput((input, key) => {
    if (step >= 4 && (key.return || input === ' ')) goTo('pickTasks');
  });

  const detected = TASKS.length;
  const agentRelevant = TASKS.filter((t) => t.confidence >= 0.7).length;

  return (
    <Frame title="my-agent-repo · first-run setup" accent={SCREEN_ACCENT.onboarding} subtitle="mock build">
      <Line label="OpenRouter API key">
        {ENV_HAS_OR_KEY ? (
          <Text color="#22c55e">✓ Using $OPENROUTER_API_KEY · credits ${OR_CREDITS_REMAINING.toFixed(2)}</Text>
        ) : (
          <Text color="#eab308">Enter your key: [•••••••••••••••••••••••] (masked)</Text>
        )}
      </Line>

      <Line label="Scanning repo">
        {step < 1 ? <Waiting /> : <Text color="#22c55e">✓ Detected runner: pnpm test</Text>}
      </Line>
      <Line label="">
        {step < 2 ? (step >= 1 ? <Waiting /> : null) : (
          <Text color="#22c55e">✓ {agentRelevant} agent-relevant tests (of {detected + 29} total)</Text>
        )}
      </Line>
      <Line label="">
        {step < 3 ? (step >= 2 ? <Waiting /> : null) : (
          <Text color="#22c55e">✓ Fetched OR catalog ({TOP_MODELS.length + 15} models · ${OR_CREDITS_REMAINING.toFixed(2)} credits left)</Text>
        )}
      </Line>
      <Line label="">
        {step < 4 ? (step >= 3 ? <Waiting /> : null) : <Text color="#22c55e">✓ Wrote .c1/config.json + added .c1/ to .gitignore</Text>}
      </Line>

      <Box marginTop={1}>
        {step >= 4 ? (
          <Text color="cyan" bold>Ready.  Press Enter →</Text>
        ) : (
          <Text color="gray">setting up…</Text>
        )}
      </Box>
    </Frame>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={22}><Text color="gray">{label}</Text></Box>
      <Box>{children}</Box>
    </Box>
  );
}

function Waiting() {
  return (
    <Text color="#eab308">
      <Spinner type="dots" /> working…
    </Text>
  );
}
