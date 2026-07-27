#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './App.tsx';
import { useStore } from './state/store.js';

const cli = meow(
  `
  Usage
    $ canaryone [flags]

  Flags
    --start <screen>   jump straight to a screen (onboarding|pickTasks|pickModels|confirm|liveProgress|report)
    --help
  `,
  {
    importMeta: import.meta,
    flags: {
      start: { type: 'string' },
    },
  },
);

if (cli.flags.start) {
  const valid = ['onboarding', 'pickTasks', 'pickModels', 'confirm', 'liveProgress', 'report'] as const;
  if (valid.includes(cli.flags.start as any)) {
    if (cli.flags.start === 'liveProgress') {
      useStore.getState().startRun();
    } else {
      useStore.getState().goTo(cli.flags.start as any);
    }
  }
}

render(<App />);
