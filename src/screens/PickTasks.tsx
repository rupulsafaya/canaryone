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
  const goTo = useStore((s) => s.goTo);
  const [cursor, setCursor] = useState(0);
  const [, termRows] = useTerminalDimensions();

  useInput((input, key) => {
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(tasks.length - 1, c + 1));
    else if (input === ' ') toggleTask(tasks[cursor].id);
    else if (input === 'a') selectAllTasks(true);
    else if (input === 'n') selectAllTasks(false);
    else if (input === 'd') { setFocusedTask(tasks[cursor].id); goTo('taskDetail'); }
    else if (key.return) goTo('pickModels');
    else if (input === 'b' || key.escape) goTo('onboarding');
  });

  const picked = tasks.filter((t) => t.included).length;
  // Chrome: border(2) + title(1) + margin(1) + col headers(1) + divider(1) + footer(3) + scroll hints(2) = ~11
  const visibleRows = Math.max(6, termRows - 11);
  const { windowStart, windowEnd, overflowAbove, overflowBelow } = useScrollWindow(tasks.length, cursor, visibleRows);

  return (
    <Frame
      title="Pick tasks"
      accent={SCREEN_ACCENT.pickTasks}
      subtitle={`${picked}/${tasks.length} selected · classified by canaryone judge`}
      footer={
        <Text color="gray">
          <Text color="cyan">↑↓</Text> nav · <Text color="cyan">space</Text> toggle · <Text color="cyan">d</Text> detail · <Text color="cyan">a</Text> all · <Text color="cyan">n</Text> none · <Text color="cyan">enter</Text> next → · <Text color="cyan">b</Text> back
        </Text>
      }
    >
      <Box flexShrink={0}>
        <Box width={4}><Text color="magenta" bold>   </Text></Box>
        <Box width={7}><Text color="magenta" bold>ID</Text></Box>
        <Box width={40}><Text color="magenta" bold>Task</Text></Box>
        <Box width={7}><Text color="magenta" bold>Conf</Text></Box>
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
            <Box width={40}><Text color={active ? 'white' : 'gray'} bold={active}>{truncate(task.name, 38)}</Text></Box>
            <Box width={7}><Text color={confidence}>{task.confidence.toFixed(2)}</Text></Box>
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
