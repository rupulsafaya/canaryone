import React, { useEffect, useState } from 'react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

// Cap the preview so a 30-KB test doesn't blow the frame. Users who want
// to see more can open the file in their editor — the `File` row above
// shows the path.
const PREVIEW_LINE_CAP = 80;
const PREVIEW_BYTE_CAP = 8_192;

export function TaskDetail() {
  const tasks = useStore((s) => s.tasks);
  const targetDir = useStore((s) => s.targetDir);
  const focusedTaskId = useStore((s) => s.focusedTaskId);
  const setFocusedTask = useStore((s) => s.setFocusedTask);
  const toggleTask = useStore((s) => s.toggleTask);
  const goTo = useStore((s) => s.goTo);
  const task = tasks.find((t) => t.id === focusedTaskId);

  // File preview state — re-reads when focused task changes so arrow-keys
  // through the task list update the preview live.
  const [preview, setPreview] = useState<{ text: string; totalLines: number; totalBytes: number; truncated: boolean } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!task) return;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    (async () => {
      try {
        const abs = path.resolve(targetDir, task.file);
        const raw = await fs.readFile(abs, 'utf8');
        if (cancelled) return;
        const allLines = raw.split('\n');
        let byteCount = 0;
        let lineCount = 0;
        const kept: string[] = [];
        for (const line of allLines) {
          const nextBytes = byteCount + Buffer.byteLength(line, 'utf8') + 1;
          if (lineCount >= PREVIEW_LINE_CAP || nextBytes > PREVIEW_BYTE_CAP) break;
          kept.push(line);
          lineCount++;
          byteCount = nextBytes;
        }
        setPreview({
          text: kept.join('\n'),
          totalLines: allLines.length,
          totalBytes: Buffer.byteLength(raw, 'utf8'),
          truncated: lineCount < allLines.length,
        });
      } catch (e) {
        if (cancelled) return;
        setPreviewError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [task?.id, targetDir]);

  useInput((input, key) => {
    if (input === 'q') {
      process.exit(0);
    } else if (input === 'b' || key.escape || key.return) {
      setFocusedTask(null);
      goTo('pickTasks');
    } else if (input === ' ' && task) {
      toggleTask(task.id);
    } else if (key.upArrow || key.leftArrow) {
      const idx = tasks.findIndex((t) => t.id === focusedTaskId);
      if (idx > 0) setFocusedTask(tasks[idx - 1].id);
    } else if (key.downArrow || key.rightArrow) {
      const idx = tasks.findIndex((t) => t.id === focusedTaskId);
      if (idx >= 0 && idx < tasks.length - 1) setFocusedTask(tasks[idx + 1].id);
    }
  });

  if (!task) {
    return <Frame title="Task detail" accent={SCREEN_ACCENT.pickTasks}><Text color="gray">No task selected. Press <Text color="cyan">b</Text> to return.</Text></Frame>;
  }

  const isFixture = task.source !== 'scan';
  const hasConfidence = Number.isFinite(task.confidence);
  const confColor = task.confidence >= 0.85 ? '#22c55e' : task.confidence >= 0.75 ? '#eab308' : '#f97316';
  const idx = tasks.findIndex((t) => t.id === task.id);

  return (
    <Frame
      title={`Task detail · ${task.id}`}
      accent={SCREEN_ACCENT.pickTasks}
      subtitle={`${idx + 1} of ${tasks.length}`}
      footer={
        <Text color="gray">
          <Text color="cyan">←→↑↓</Text> next/prev task · <Text color="cyan">space</Text> toggle include · <Text color="cyan">enter / b</Text> back · <Text color="cyan">q</Text> quit
        </Text>
      }
    >
      <Row label="Included">
        <Text color={task.included ? '#22c55e' : '#94a3b8'} bold>{task.included ? '● YES' : '○ no'}</Text>
      </Row>
      <Row label="Task ID"><Text color="white" bold>{task.id}</Text></Row>
      <Row label="Name"><Text color="white">{task.name}</Text></Row>
      <Row label="File"><Text color="cyan">{task.file}</Text></Row>
      <Row label="Verify"><Text color="magenta">{task.verifyCmd}</Text></Row>
      {typeof task.usesLLM === 'boolean' && (
        <Row label="Uses LLM">
          {task.usesLLM
            ? <Text color="#22c55e" bold>● yes{task.llmEvidence ? <Text color="gray" dimColor>  — {task.llmEvidence}</Text> : null}</Text>
            : <Text color="#94a3b8">○ no{task.llmEvidence ? <Text color="gray" dimColor>  — {task.llmEvidence}</Text> : null}</Text>}
        </Row>
      )}
      {hasConfidence && (
        <Row label="Judge confidence">
          <Text color={confColor}>
            {task.confidence.toFixed(2)}
            <Text color="gray" dimColor>{'  '}({task.confidence >= 0.85 ? 'high' : task.confidence >= 0.75 ? 'medium' : 'low'})</Text>
          </Text>
        </Row>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color="magenta" bold>Summary</Text>
        <Box paddingLeft={2} paddingTop={0}><Text color="gray">{task.summary}</Text></Box>
      </Box>
      {isFixture && (
        <Box marginTop={1} flexDirection="column">
          <Text color="magenta" bold>What the classifier saw</Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text color="gray">• Test file references an <Text color="white">agent invocation</Text> (spawn / import chain).</Text>
            <Text color="gray">• Assertions gated on <Text color="white">multi-step LLM completion</Text>, not deterministic units.</Text>
            <Text color="gray">• Verify command returns non-zero on failure; ground-truth outcome free.</Text>
          </Box>
        </Box>
      )}
      {!isFixture && task.bullets && task.bullets.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="magenta" bold>What the test does</Text>
          <Box paddingLeft={2} flexDirection="column">
            {task.bullets.map((b, i) => (
              <Text key={i} color="gray">• {b}</Text>
            ))}
          </Box>
          <Box marginTop={1} paddingLeft={2}>
            <Text color="gray" dimColor>read by Claude Haiku 4.5 · cached in .c1/config.json</Text>
          </Box>
        </Box>
      )}
      {!isFixture && (!task.bullets || task.bullets.length === 0) && (
        <Box marginTop={1} flexDirection="column">
          <Text color="magenta" bold>What the test does</Text>
          <Box paddingLeft={2}>
            <Text color="gray" dimColor>(no summary — LLM read failed or was skipped)</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column" flexShrink={1} overflow="hidden">
        <Box>
          <Text color="magenta" bold>Test file source</Text>
          {preview && (
            <Text color="gray" dimColor>{'   '}({preview.totalLines} lines · {formatBytes(preview.totalBytes)}{preview.truncated ? ` · showing first ${PREVIEW_LINE_CAP}` : ''})</Text>
          )}
        </Box>
        <Box paddingLeft={2} flexDirection="column" flexShrink={1} overflow="hidden">
          {previewError && <Text color="#ef4444" dimColor>could not read: {previewError}</Text>}
          {!previewError && !preview && <Text color="gray" dimColor>reading…</Text>}
          {!previewError && preview && preview.text.split('\n').map((line, i) => (
            <Box key={i}>
              <Box width={5}><Text color="#3f3f46">{String(i + 1).padStart(4)} </Text></Box>
              <Text color="white">{line || ' '}</Text>
            </Box>
          ))}
          {!previewError && preview && preview.truncated && (
            <Text color="gray" dimColor>  … +{preview.totalLines - PREVIEW_LINE_CAP} more lines. Open the file in your editor to see the rest.</Text>
          )}
        </Box>
      </Box>
    </Frame>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={18}><Text color="gray">{label}</Text></Box>
      <Box>{children}</Box>
    </Box>
  );
}
