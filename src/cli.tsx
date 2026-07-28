#!/usr/bin/env node
import React from 'react';
import path from 'node:path';
import { render } from 'ink';
import meow from 'meow';
import { App } from './App.tsx';
import { useStore } from './state/store.js';

const cli = meow(
  `
  Usage
    $ c1 [flags]

  Flags
    --target <dir>              target repo (default: cwd)
    --config-dir <dir>          where .c1/ lives (default: <target>/.c1)
    --rescan                    force re-run of deterministic scan
    --rescan-methodology        force re-run of methodology detection (bypasses cache)
    --start <screen>            jump straight to a screen (onboarding|summarizeTasks|methodologyCheck|pickTasks|taskDetail|pickModels|pickDestinations|confirm|liveProgress)
    --help
  `,
  {
    importMeta: import.meta,
    flags: {
      target: { type: 'string' },
      configDir: { type: 'string' },
      rescan: { type: 'boolean', default: false },
      rescanMethodology: { type: 'boolean', default: false },
      start: { type: 'string' },
    },
  },
);

const targetDir = path.resolve(cli.flags.target ?? process.cwd());
const configDir = path.resolve(
  cli.flags.configDir ?? process.env.C1_CONFIG_DIR ?? path.join(targetDir, '.c1'),
);
useStore.setState({
  targetDir,
  configDir,
  cwd: targetDir,
  forceRescan: cli.flags.rescan,
  forceRescanMethodology: cli.flags.rescanMethodology,
});

if (cli.flags.start) {
  const valid = ['keySetup', 'onboarding', 'summarizeTasks', 'methodologyCheck', 'pickTasks', 'taskDetail', 'pickModels', 'pickDestinations', 'confirm', 'liveProgress'] as const;
  if (valid.includes(cli.flags.start as any)) {
    // Downstream screens need pre-populated selection to have anything to
    // render. Seed the demo/fixture selection so `--start pickDestinations`
    // etc. keeps working for iteration on those screens. Real users starting
    // from KeySetup/Onboarding begin with an empty selection.
    // Seed models only when a downstream screen genuinely can't render an
    // empty selection (confirm and liveProgress compute cost/lanes; pickDestinations
    // needs models to have anything to fetch endpoints for). Destinations are
    // NEVER seeded — user must pick at least one per model to advance.
    const seedModels = ['pickDestinations', 'confirm', 'liveProgress'].includes(cli.flags.start);
    const seedDestinations = ['confirm', 'liveProgress'].includes(cli.flags.start);
    if (seedModels) {
      const state: any = {
        selectedModels: new Set(['anthropic/claude-haiku-4.5', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.2']),
      };
      if (seedDestinations) {
        state.selectedDestinations = {
          'anthropic/claude-haiku-4.5': new Set(['openrouter:anthropic']),
          'deepseek/deepseek-v4-flash': new Set(['openrouter:baidu']),
          'z-ai/glm-5.2':               new Set(['openrouter:baseten/fp8']),
        };
      } else {
        // Empty destination sets so the "must-pick" gate is exercised on demo path.
        state.selectedDestinations = {
          'anthropic/claude-haiku-4.5': new Set<string>(),
          'deepseek/deepseek-v4-flash': new Set<string>(),
          'z-ai/glm-5.2':               new Set<string>(),
        };
      }
      useStore.setState(state);
    }
    if (cli.flags.start === 'liveProgress') {
      useStore.getState().startRun();
    } else {
      useStore.getState().goTo(cli.flags.start as any);
    }
  }
}

render(<App />);
