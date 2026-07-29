import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import { ScrollHint } from '../components/ScrollHint.tsx';
import { useScrollWindow, useTerminalDimensions } from '../hooks/useScrollWindow.ts';

export function PickTasks() {
  const tasks = useStore((s) => s.tasks);
  const toggleTask = useStore((s) => s.toggleTask);
  const selectAllTasks = useStore((s) => s.selectAllTasks);
  const setFocusedTask = useStore((s) => s.setFocusedTask);
  const persistTaskSelection = useStore((s) => s.persistTaskSelection);
  const goTo = useStore((s) => s.goTo);
  const [cursor, setCursor] = useState(0);
  const [, termRows] = useTerminalDimensions();

  const picked = tasks.filter((t) => t.included).length;
  const hasClassifier = tasks.length > 0 && tasks.some((t) => t.source !== 'scan' && Number.isFinite(t.confidence));
  const hasLLMData = tasks.length > 0 && tasks.some((t) => typeof t.usesLLM === 'boolean');
  const nonLLMCount = tasks.filter((t) => t.usesLLM === false && t.included).length;
  const llmTotal = tasks.filter((t) => t.usesLLM === true).length;

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(tasks.length - 1, c + 1));
    else if (input === ' ') toggleTask(tasks[cursor].id);
    else if (input === 'a') selectAllTasks(true);
    else if (input === 'n') selectAllTasks(false);
    else if (input === 'x' && hasLLMData) {
      // Uncheck all tests that don't invoke an LLM (keeps LLM picks as-is)
      tasks.forEach((t) => { if (t.usesLLM === false && t.included) toggleTask(t.id); });
    }
    else if (input === 'L' && hasLLMData) {
      // Bulk: select ONLY LLM tests. One keystroke replaces `a` + `x` + manual
      // scrolling on 400+ test repos. Reconciles cell-by-cell: check every
      // usesLLM===true, uncheck everything else.
      tasks.forEach((t) => {
        const shouldBeIncluded = t.usesLLM === true;
        if (t.included !== shouldBeIncluded) toggleTask(t.id);
      });
    }
    else if (input === 'd') { setFocusedTask(tasks[cursor].id); goTo('taskDetail'); }
    else if (key.return) {
      if (picked > 0) {
        void persistTaskSelection();
        goTo('pickRoutes');
      }
    }
    else if (input === 'b' || key.escape) goTo('onboarding');
    else if (input === 'q') process.exit(0);
  });

  // Chrome: border(2) + title(1) + margin(1) + col headers(1) + divider(1) + footer(3) + scroll hints(2) = ~11
  const visibleRows = Math.max(6, termRows - 11);
  const { windowStart, windowEnd, overflowAbove, overflowBelow } = useScrollWindow(tasks.length, cursor, visibleRows);

  return (
    <Frame
      title="Pick tasks"
      accent={SCREEN_ACCENT.pickTasks}
      subtitle={`${picked}/${tasks.length} selected${hasLLMData ? ` · ${llmTotal} use LLMs` : ''}${hasClassifier ? ' · classified by canaryone judge' : ' · read by Haiku 4.5'}${nonLLMCount > 0 ? ` · ${nonLLMCount} non-LLM checked` : ''}`}
      footer={
        <Text color="gray">
          <Text color="cyan">↑↓</Text> nav · <Text color="cyan">space</Text> toggle · <Text color="cyan">d</Text> detail · <Text color="cyan">a</Text> all · <Text color="cyan">n</Text> none{hasLLMData ? <Text> · <Text color="#22c55e" bold>L</Text> LLM-only · <Text color="cyan">x</Text> uncheck non-LLM</Text> : null} · {picked > 0
            ? <Text color="#22c55e" bold>enter next →</Text>
            : <Text dimColor>enter (pick ≥1 test)</Text>} · <Text color="cyan">b</Text> back · <Text color="cyan">q</Text> quit
        </Text>
      }
    >
      <Box flexShrink={0}>
        <Box width={4}><Text color="magenta" bold>   </Text></Box>
        <Box width={7}><Text color="magenta" bold>ID</Text></Box>
        {hasLLMData && <Box width={6}><Text color="magenta" bold>LLM</Text></Box>}
        <Box width={38}><Text color="magenta" bold>Task</Text></Box>
        {hasClassifier && <Box width={7}><Text color="magenta" bold>Conf</Text></Box>}
        <Text color="magenta" bold>Summary</Text>
      </Box>
      <Box flexShrink={0}><Text color="gray" dimColor>{'─'.repeat(90)}</Text></Box>

      <ScrollHint side="above" count={overflowAbove} />

      {tasks.slice(windowStart, windowEnd).map((task, offset) => {
        const i = windowStart + offset;
        const active = i === cursor;
        const check = task.included ? '●' : '○';
        const confidence = task.confidence >= 0.85 ? '#22c55e' : task.confidence >= 0.75 ? '#eab308' : '#f97316';
        return (
          <Box key={task.id} flexShrink={0}>
            <Box width={4}>
              {active ? <Text color="cyan" bold>▸ </Text> : <Text>  </Text>}
              <Text color={task.included ? '#22c55e' : '#64748b'}>{check}</Text>
            </Box>
            <Box width={7}><Text color={active ? 'white' : 'gray'} bold={active}>{task.id}</Text></Box>
            {hasLLMData && (
              <Box width={6}>
                {task.usesLLM === true
                  ? <Text color="#22c55e" bold>● yes</Text>
                  : task.usesLLM === false
                    ? <Text color="#94a3b8" dimColor>○ no</Text>
                    : <Text color="#eab308">?</Text>}
              </Box>
            )}
            <Box width={38}><Text color={active ? 'white' : 'gray'} bold={active}>{truncate(task.name, 36)}</Text></Box>
            {hasClassifier && (
              <Box width={7}>
                <Text color={Number.isFinite(task.confidence) ? confidence : '#64748b'}>
                  {Number.isFinite(task.confidence) ? task.confidence.toFixed(2) : '—'}
                </Text>
              </Box>
            )}
            <Text color="gray" dimColor>{truncate(task.summary, 42)}</Text>
          </Box>
        );
      })}

      <ScrollHint side="below" count={overflowBelow} />
    </Frame>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}
