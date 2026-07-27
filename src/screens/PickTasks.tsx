import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';

export function PickTasks() {
  const tasks = useStore((s) => s.tasks);
  const toggleTask = useStore((s) => s.toggleTask);
  const selectAllTasks = useStore((s) => s.selectAllTasks);
  const setFocusedTask = useStore((s) => s.setFocusedTask);
  const goTo = useStore((s) => s.goTo);
  const [cursor, setCursor] = useState(0);

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

  return (
    <Frame
      title="my-agent-repo · Pick tasks"
      accent={SCREEN_ACCENT.pickTasks}
      subtitle={`${picked}/${tasks.length} selected · classified by canaryone judge`}
      footer={
        <Text color="gray">
          <Text color="cyan">↑↓</Text> nav · <Text color="cyan">space</Text> toggle · <Text color="cyan">d</Text> detail · <Text color="cyan">a</Text> all · <Text color="cyan">n</Text> none · <Text color="cyan">enter</Text> next → · <Text color="cyan">b</Text> back
        </Text>
      }
    >
      {/* Column header row */}
      <Box>
        <Box width={4}><Text color="gray" bold>   </Text></Box>
        <Box width={7}><Text color="magenta" bold>ID</Text></Box>
        <Box width={40}><Text color="magenta" bold>Task</Text></Box>
        <Box width={7}><Text color="magenta" bold>Conf</Text></Box>
        <Text color="magenta" bold>Summary</Text>
      </Box>
      <Box>
        <Text color="gray" dimColor>{'─'.repeat(90)}</Text>
      </Box>

      {tasks.map((task, i) => {
        const active = i === cursor;
        const check = task.included ? '●' : '○';
        const confidence = task.confidence >= 0.85 ? '#22c55e' : task.confidence >= 0.75 ? '#eab308' : '#f97316';
        return (
          <Box key={task.id}>
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
    </Frame>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}
