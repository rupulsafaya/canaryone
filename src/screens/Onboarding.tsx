import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../state/store.js';
import { ENV_HAS_OR_KEY, OR_CREDITS_REMAINING, TOP_MODELS, TASKS } from '../data/fixtures.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

const STEP_LABELS = [
  { label: 'OpenRouter API key',       done: () => ENV_HAS_OR_KEY ? `✓ Using $OPENROUTER_API_KEY · credits $${OR_CREDITS_REMAINING.toFixed(2)}` : 'Enter your key: [•••••••••••••••••••••••] (masked)' },
  { label: 'Runner detection',         done: () => '✓ Detected: pnpm test  ·  entrypoint: package.json:scripts.test' },
  { label: 'Agent-relevant tests',     done: () => `✓ ${TASKS.filter((t) => t.confidence >= 0.7).length} agent-relevant of ${TASKS.length + 29} total (judge-classified)` },
  { label: 'OR catalog',               done: () => `✓ Fetched ${TOP_MODELS.length + 15} models · ${OR_CREDITS_REMAINING.toFixed(2)} credits left` },
  { label: 'Local config',             done: () => '✓ Wrote .c1/config.json + added .c1/ to .gitignore' },
];

export function Onboarding() {
  const goTo = useStore((s) => s.goTo);
  const cwd = useStore((s) => s.cwd);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (step >= STEP_LABELS.length) return;
    const t = setTimeout(() => setStep((s) => s + 1), step === 0 ? 400 : 700);
    return () => clearTimeout(t);
  }, [step]);

  useInput((input, key) => {
    if (step >= STEP_LABELS.length && (key.return || input === ' ')) goTo('pickTasks');
  });

  return (
    <Frame
      title="first-run setup"
      accent={SCREEN_ACCENT.onboarding}
      subtitle="mock build"
      footer={
        <Text color="gray">
          {step >= STEP_LABELS.length ? <Text color="cyan" bold>Ready. Press Enter →</Text> : 'setting up…'}
        </Text>
      }
    >
      <Row label="Target directory">
        <Text color="white">{cwd}</Text>
      </Row>
      <Box marginTop={1} />

      {STEP_LABELS.map((s, i) => (
        <StepRow key={i} label={s.label} state={i < step ? 'done' : i === step ? 'running' : 'pending'} doneText={s.done()} />
      ))}
    </Frame>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={22}><Text color="gray">{label}</Text></Box>
      <Box>{children}</Box>
    </Box>
  );
}

function StepRow({ label, state, doneText }: { label: string; state: 'pending' | 'running' | 'done'; doneText: string }) {
  return (
    <Box>
      <Box width={22}><Text color="gray">{label}</Text></Box>
      <Box>
        {state === 'pending' && <Text color="#3f3f46">·  waiting</Text>}
        {state === 'running' && <Text color="#eab308"><Spinner type="dots" /> working…</Text>}
        {state === 'done' && <Text color="#22c55e">{doneText}</Text>}
      </Box>
    </Box>
  );
}
