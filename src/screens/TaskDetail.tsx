import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

export function TaskDetail() {
  const tasks = useStore((s) => s.tasks);
  const focusedTaskId = useStore((s) => s.focusedTaskId);
  const setFocusedTask = useStore((s) => s.setFocusedTask);
  const toggleTask = useStore((s) => s.toggleTask);
  const goTo = useStore((s) => s.goTo);
  const task = tasks.find((t) => t.id === focusedTaskId);

  useInput((input, key) => {
    if (input === 'b' || key.escape || key.return) {
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

  const confColor = task.confidence >= 0.85 ? '#22c55e' : task.confidence >= 0.75 ? '#eab308' : '#f97316';
  const idx = tasks.findIndex((t) => t.id === task.id);

  return (
    <Frame
      title={`Task detail · ${task.id}`}
      accent={SCREEN_ACCENT.pickTasks}
      subtitle={`${idx + 1} of ${tasks.length}`}
      footer={
        <Text color="gray">
          <Text color="cyan">←→↑↓</Text> next/prev task · <Text color="cyan">space</Text> toggle include · <Text color="cyan">enter / b</Text> back
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
      <Row label="Judge confidence"><Text color={confColor}>{task.confidence.toFixed(2)}</Text> <Text color="gray" dimColor>({task.confidence >= 0.85 ? 'high' : task.confidence >= 0.75 ? 'medium' : 'low'})</Text></Row>
      <Box marginTop={1} flexDirection="column">
        <Text color="magenta" bold>Summary</Text>
        <Box paddingLeft={2} paddingTop={0}><Text color="gray">{task.summary}</Text></Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="magenta" bold>What the classifier saw</Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text color="gray">• Test file references an <Text color="white">agent invocation</Text> (spawn / import chain).</Text>
          <Text color="gray">• Assertions gated on <Text color="white">multi-step LLM completion</Text>, not deterministic units.</Text>
          <Text color="gray">• Verify command returns non-zero on failure; ground-truth outcome free.</Text>
        </Box>
      </Box>
    </Frame>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={18}><Text color="gray">{label}</Text></Box>
      <Box>{children}</Box>
    </Box>
  );
}
