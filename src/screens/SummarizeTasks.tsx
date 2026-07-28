import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import {
  summarizeTests,
  SUMMARY_MODEL,
  type SummariesMap,
  type SummarizeProgress,
  type SummarizeItemResult,
} from '../scan/summarize.js';
import { writeConfig } from '../scan/orchestrator.js';

type Mode = 'running' | 'done' | 'error' | 'partial';

export function SummarizeTasks() {
  const goTo = useStore((s) => s.goTo);
  const targetDir = useStore((s) => s.targetDir);
  const configDir = useStore((s) => s.configDir);
  const matchedFiles = useStore((s) => s.matchedFiles);
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);

  const [mode, setMode] = useState<Mode>('running');
  const [progress, setProgress] = useState<SummarizeProgress[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [doneCount, setDoneCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [cachedCount, setCachedCount] = useState(0);
  const [results, setResults] = useState<SummarizeItemResult[]>([]);

  const total = matchedFiles.length;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!config) {
        setErrorMsg('No config in store. Should be set by Onboarding.accept before this screen.');
        setMode('error');
        return;
      }
      if (matchedFiles.length === 0) {
        // Nothing to summarize; advance immediately.
        goTo('methodologyCheck');
        return;
      }
      try {
        const { summaries, results } = await summarizeTests({
          files: matchedFiles,
          targetDir,
          existing: config.tasks.summaries,
          onProgress: (p) => {
            if (cancelled) return;
            setProgress((prev) => {
              const next = [...prev];
              next[p.index] = p;
              return next;
            });
            if (p.status === 'done') setDoneCount((n) => n + 1);
            if (p.status === 'error') setErrorCount((n) => n + 1);
            if (p.status === 'cached') setCachedCount((n) => n + 1);
          },
        });
        if (cancelled) return;

        // Persist config with summaries.
        const nextConfig = {
          ...config,
          tasks: { ...config.tasks, summaries },
          updatedAt: new Date().toISOString(),
        };
        await writeConfig(configDir, nextConfig);
        setConfig(nextConfig);

        setResults(results);
        const failed = results.filter((r) => !r.ok).length;
        if (failed === matchedFiles.length) {
          setMode('error');
          setErrorMsg('All summaries failed. Check network / OR key / rate limits.');
        } else if (failed > 0) {
          setMode('partial');
        } else {
          setMode('done');
        }
      } catch (e) {
        if (cancelled) return;
        setErrorMsg(String(e instanceof Error ? e.message : e));
        setMode('error');
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input, key) => {
    if (mode === 'running') {
      if (input === 'q' || key.escape) process.exit(0);
      return;
    }
    if (mode === 'error') {
      if (input === 'q' || key.escape) process.exit(1);
      if (input === 's') goTo('methodologyCheck'); // skip forward with empty summaries
      return;
    }
    // done or partial
    if (key.return) goTo('methodologyCheck');
    else if (input === 'q' || key.escape) process.exit(0);
  });

  const current = progress.length > 0
    ? [...progress].reverse().find((p) => p && (p.status === 'reading' || p.status === 'calling'))
    : null;

  return (
    <Frame
      title="Reading tests"
      accent={SCREEN_ACCENT.pickTasks}
      subtitle={
        mode === 'running' ? `${doneCount + cachedCount}/${total} · Haiku 4.5`
          : mode === 'done' ? 'all summaries ready'
          : mode === 'partial' ? `${doneCount + cachedCount} of ${total} succeeded · ${errorCount} failed`
          : 'summarize failed'
      }
      footer={<Footer mode={mode} />}
    >
      <Text color="gray">
        Reading each matched test with <Text color="white">{SUMMARY_MODEL}</Text> to build a one-line summary + bullets.
      </Text>
      <Text color="gray" dimColor>~$0.001 per test · cached to .c1/config.json (invalidated on file change)</Text>
      <Box marginTop={1} />

      {mode === 'running' && (
        <Box flexDirection="column">
          <Text color="#eab308">
            <Spinner type="dots" /> {doneCount + cachedCount}/{total} done{cachedCount > 0 ? ` · ${cachedCount} from cache` : ''}{errorCount > 0 ? ` · ${errorCount} errors` : ''}
          </Text>
          {current && (
            <Box marginTop={1}>
              <Text color="gray">current: </Text>
              <Text color="white">{current.file}</Text>
              <Text color="gray" dimColor>  ({current.status})</Text>
            </Box>
          )}
        </Box>
      )}

      {(mode === 'done' || mode === 'partial') && (
        <Box flexDirection="column">
          <Text color={mode === 'done' ? '#22c55e' : '#eab308'} bold>
            {mode === 'done'
              ? `✓ ${results.length} test${results.length === 1 ? '' : 's'} summarized`
              : `⚠ ${errorCount} failed of ${results.length}${errorCount ? ' — those show as file paths' : ''}`}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {results.map((r, i) => (
              <SummaryPreview key={i} result={r} />
            ))}
          </Box>
        </Box>
      )}

      {mode === 'error' && (
        <Box flexDirection="column">
          <Text color="#ef4444" bold>✗ summarize failed</Text>
          <Text color="gray">{errorMsg}</Text>
        </Box>
      )}
    </Frame>
  );
}

function SummaryPreview({ result }: { result: SummarizeItemResult }) {
  if (!result.ok || !result.summary) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>{result.file}</Text>
        <Box paddingLeft={2}>
          <Text color="#ef4444" dimColor>failed: {result.error ?? 'unknown error'}</Text>
        </Box>
      </Box>
    );
  }
  const uses = result.summary.usesLLM;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>{result.file}</Text>
        <Text color="gray">  </Text>
        {uses === true
          ? <Text color="#22c55e" bold>● uses LLM</Text>
          : uses === false
            ? <Text color="#94a3b8" dimColor>○ no LLM</Text>
            : <Text color="#eab308">? unknown</Text>}
        {result.summary.llmEvidence && (
          <Text color="gray" dimColor>  — {result.summary.llmEvidence}</Text>
        )}
      </Box>
      <Box paddingLeft={2}><Text color="white">{result.summary.summary}</Text></Box>
      <Box paddingLeft={2} flexDirection="column">
        {result.summary.bullets.slice(0, 5).map((b, i) => (
          <Text key={i} color="gray">• {b}</Text>
        ))}
      </Box>
    </Box>
  );
}

function Footer({ mode }: { mode: Mode }) {
  if (mode === 'running') {
    return <Text color="gray">please wait · <Text color="cyan">q</Text> quit</Text>;
  }
  if (mode === 'error') {
    return <Text color="gray"><Text color="cyan">s</Text> skip (no summaries) · <Text color="cyan">q</Text> quit</Text>;
  }
  return <Text color="gray"><Text color="#22c55e" bold>enter continue →</Text> · <Text color="cyan">q</Text> quit</Text>;
}
