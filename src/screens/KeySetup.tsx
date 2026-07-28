import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import {
  detectOrKey,
  validateOrKey,
  writeOrKeyToHomeDotenv,
  HOME_ENV_PATH,
} from '../scan/orchestrator.js';
import type { ORKeySource } from '../data/schema.js';

type Mode = 'checking' | 'validating' | 'ready' | 'prompt' | 'invalid';

export function KeySetup() {
  const goTo = useStore((s) => s.goTo);
  const setOrKey = useStore((s) => s.setOrKey);

  const [mode, setMode] = useState<Mode>('checking');
  const [source, setSource] = useState<ORKeySource | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState('');
  const [keyLen, setKeyLen] = useState(0);

  // Boot: check for a saved key; if found, validate it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const detected = await detectOrKey();
      if (cancelled) return;
      if (!detected.present || !detected.value) {
        setMode('prompt');
        return;
      }
      setSource(detected.source);
      setKeyLen(detected.value.length);
      setMode('validating');
      const result = await validateOrKey(detected.value);
      if (cancelled) return;
      if (result.ok) {
        setCredits(result.credits);
        setOrKey(true, detected.source);
        setMode('ready');
      } else {
        setLastError(result.error);
        setMode('invalid');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    const trimmed = draftKey.trim();
    if (!trimmed) return;
    setMode('validating');
    const result = await validateOrKey(trimmed);
    if (!result.ok) {
      setLastError(result.error);
      setMode('invalid');
      return;
    }
    await writeOrKeyToHomeDotenv(trimmed);
    setSource('~/.c1/.env');
    setKeyLen(trimmed.length);
    setCredits(result.credits);
    setOrKey(true, '~/.c1/.env');
    setDraftKey('');
    setMode('ready');
  };

  useInput((input, key) => {
    if (mode === 'checking' || mode === 'validating') {
      if (input === 'q' || key.escape) process.exit(0);
      return;
    }
    if (mode === 'ready') {
      if (key.return) goTo('onboarding');
      else if (input === 'k') { setMode('prompt'); setDraftKey(''); }
      else if (input === 'q' || key.escape) process.exit(0);
      return;
    }
    if (mode === 'invalid') {
      if (input === 'r' || key.return) { setMode('prompt'); setDraftKey(''); setLastError(null); }
      else if (input === 'q' || key.escape) process.exit(1);
      return;
    }
    // mode === 'prompt'
    if (key.return) { submit(); return; }
    if (key.escape) process.exit(0);
    if (key.backspace || key.delete) { setDraftKey((d) => d.slice(0, -1)); return; }
    const cleaned = sanitizeInput(input);
    if (cleaned) setDraftKey((d) => d + cleaned);
  });

  return (
    <Frame
      title="welcome"
      accent={SCREEN_ACCENT.onboarding}
      subtitle={
        mode === 'checking' ? 'looking for your OpenRouter key…'
          : mode === 'validating' ? 'validating with OpenRouter…'
          : mode === 'ready' ? 'key ready'
          : mode === 'invalid' ? 'key not accepted'
          : 'paste your OpenRouter key'
      }
      footer={<Footer mode={mode} draftLen={draftKey.length} />}
    >
      <Text color="gray">canaryone uses OpenRouter to fetch model info and route benchmarks.</Text>
      <Text color="gray">Your key stays on this machine; only OpenRouter sees it.</Text>
      <Box marginTop={1} />

      {(mode === 'checking' || mode === 'validating') && (
        <Text color="#eab308">
          <Spinner type="dots" />
          {mode === 'checking' ? ' checking ~/.c1/.env…' : ' calling OpenRouter…'}
        </Text>
      )}

      {mode === 'ready' && (
        <Box flexDirection="column">
          <KV label="Status" value={<Text color="#22c55e">✓ valid</Text>} />
          <KV label="Source" value={<Text color="white">{sourceLabel(source)}</Text>} />
          <KV label="Key" value={<Text color="gray">{maskedFor(keyLen)}</Text>} />
          <KV label="Credits" value={credits == null
            ? <Text color="gray" dimColor>—</Text>
            : <Text color="white" bold>${credits.toFixed(2)}</Text>} />
        </Box>
      )}

      {mode === 'invalid' && (
        <Box flexDirection="column">
          <Text color="#ef4444" bold>✗ OpenRouter did not accept this key</Text>
          {lastError && <Text color="gray">reason: {lastError}</Text>}
          <Text color="gray" dimColor>Get one at </Text>
          <Text color="cyan" dimColor>https://openrouter.ai/keys</Text>
        </Box>
      )}

      {mode === 'prompt' && (
        <Box flexDirection="column">
          <Text color="gray">No key found in ~/.c1/.env. Paste your OpenRouter API key:</Text>
          <Box marginTop={1}>
            <Box width={8}><Text color="cyan">Key</Text></Box>
            <Text color="white">{maskedFor(draftKey.length)}</Text>
            <Text color="gray">▏</Text>
            {draftKey.length > 0 && <Text color="gray" dimColor>  ({draftKey.length} chars)</Text>}
          </Box>
          <Box marginTop={1}>
            <Text color="gray" dimColor>Saved to </Text>
            <Text color="white">{HOME_ENV_PATH}</Text>
            <Text color="gray" dimColor> (mode 0600)</Text>
          </Box>
          <Box>
            <Text color="gray" dimColor>Get one at </Text>
            <Text color="cyan" dimColor>https://openrouter.ai/keys</Text>
          </Box>
        </Box>
      )}
    </Frame>
  );
}

function Footer({ mode, draftLen }: { mode: Mode; draftLen: number }) {
  if (mode === 'checking' || mode === 'validating') {
    return <Text color="gray">please wait · <Text color="cyan">q</Text> quit</Text>;
  }
  if (mode === 'ready') {
    return (
      <Text color="gray">
        <Text color="#22c55e" bold>enter continue →</Text>
        <Text color="gray"> · </Text><Text color="cyan">k</Text> change key · <Text color="cyan">q</Text> quit
      </Text>
    );
  }
  if (mode === 'invalid') {
    return (
      <Text color="gray">
        <Text color="#eab308" bold>enter</Text>/<Text color="cyan">r</Text> retry · <Text color="cyan">q</Text> quit
      </Text>
    );
  }
  return (
    <Text color="gray">
      {draftLen > 0
        ? <Text color="#22c55e" bold>enter save + validate</Text>
        : <Text dimColor>enter (paste key first)</Text>}
      <Text color="gray"> · </Text><Text color="cyan">q</Text> quit
    </Text>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box>
      <Box width={10}><Text color="cyan">{label}</Text></Box>
      <Box>{value}</Box>
    </Box>
  );
}

function maskedFor(len: number): string {
  if (len === 0) return '(empty)';
  return '•'.repeat(Math.min(len, 32));
}

function sourceLabel(s: ORKeySource | null): string {
  if (s === 'env:OPENROUTER_API_KEY') return '$OPENROUTER_API_KEY';
  if (s === '~/.c1/.env') return '~/.c1/.env';
  return '';
}

function sanitizeInput(input: string): string {
  if (!input) return '';
  // Handle multi-char paste: strip bracketed-paste markers + control chars,
  // keep everything printable. Fixes the length===1 bug where pasted keys
  // (delivered as a single chunk) were dropped entirely.
  return input
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}
