import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import { runFirstRunScan, writeConfig, ensureGitignore } from '../scan/orchestrator.js';
import { expandGlob, matchFiles, isGlob, type MatchedFile } from '../scan/glob.js';
import type { Config } from '../data/schema.js';

type Row = 'runner' | 'glob' | 'found';
const EDITABLE_ROWS: Row[] = ['runner', 'glob', 'found'];
const ROW_LABELS: Record<Row, string> = {
  runner: 'Runner',
  glob: 'Test glob',
  found: 'Found',
};

type Mode = 'scanning' | 'wizard' | 'editing' | 'viewing' | 'error';

export function Onboarding() {
  const goTo = useStore((s) => s.goTo);
  const targetDir = useStore((s) => s.targetDir);
  const configDir = useStore((s) => s.configDir);
  const forceRescan = useStore((s) => s.forceRescan);
  const setScanResult = useStore((s) => s.setScanResult);
  const setConfig = useStore((s) => s.setConfig);
  const setMatchedFilesStore = useStore((s) => s.setMatchedFiles);
  const orKeySourceFromStore = useStore((s) => s.orKeySource);

  const [mode, setMode] = useState<Mode>('scanning');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [cursor, setCursor] = useState(0);
  const [draftRunner, setDraftRunner] = useState('');
  const [draftGlob, setDraftGlob] = useState('');
  const [detectedFrom, setDetectedFrom] = useState<Config['runner']['detectedFrom']>('user');
  const [matched, setMatched] = useState<MatchedFile[]>([]);
  const [matching, setMatching] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [viewCursor, setViewCursor] = useState(0);

  // Mount: run the scan.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await runFirstRunScan({ targetDir, configDir, forceRescan });
        if (cancelled) return;
        setScanResult(result.scan);
        const topRunner = result.scan.runners[0];
        setDraftRunner(topRunner.cmd);
        setDetectedFrom(inferDetectedFrom(topRunner.source));
        const initGlob = result.config?.testGlob.pattern ?? result.scan.suggestedGlob ?? '';
        setDraftGlob(initGlob);
        if (initGlob) {
          const files = await matchFiles(targetDir, initGlob);
          if (cancelled) return;
          setMatched(files);
          setMatchedFilesStore(files);
        }
        setMode('wizard');
      } catch (e) {
        if (cancelled) return;
        setErrorMsg(String(e instanceof Error ? e.message : e));
        setMode('error');
      }
    })();
    return () => { cancelled = true; };
  }, [targetDir, configDir, forceRescan]);

  const rerunMatch = async (pattern: string) => {
    setMatching(true);
    try {
      const files = await matchFiles(targetDir, pattern);
      setMatched(files);
      setMatchedFilesStore(files);
    } finally {
      setMatching(false);
    }
  };

  const accept = async () => {
    if (matched.length === 0) return;
    const now = new Date().toISOString();
    const config: Config = {
      version: '0.0',
      targetDir,
      runner: {
        cmd: draftRunner.trim(),
        cwd: null,
        detectedFrom,
      },
      testGlob: {
        pattern: draftGlob,
        expanded: expandGlob(draftGlob),
      },
      // User must pick tests explicitly on PickTasks — Onboarding does not
      // pre-populate the included list.
      tasks: { included: [] },
      orKey: { source: orKeySourceFromStore ?? '~/.c1/.env' },
      createdAt: now,
      updatedAt: now,
    };
    await writeConfig(configDir, config);
    await ensureGitignore(targetDir, configDir);
    setConfig(config);
    goTo('summarizeTasks');
  };

  const commitEdit = async () => {
    if (editing === 'runner') {
      const trimmed = editDraft.trim();
      if (trimmed) {
        setDraftRunner(trimmed);
        setDetectedFrom('user');
      }
      setEditing(null);
    } else if (editing === 'glob') {
      const trimmed = editDraft.trim();
      if (trimmed) {
        setDraftGlob(trimmed);
        setEditing(null);
        await rerunMatch(trimmed);
      } else {
        setEditing(null);
      }
    }
    setEditDraft('');
  };

  useInput((input, key) => {
    if (mode === 'scanning' || mode === 'error') {
      if (input === 'q' || key.escape) process.exit(mode === 'error' ? 1 : 0);
      return;
    }

    if (mode === 'viewing') {
      if (key.upArrow) setViewCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setViewCursor((c) => Math.min(Math.max(0, matched.length - 1), c + 1));
      else if (input === 'b' || key.escape || key.return) setMode('wizard');
      return;
    }

    if (mode === 'editing') {
      if (key.return) { commitEdit(); return; }
      if (key.escape) { setEditing(null); setEditDraft(''); return; }
      if (key.backspace || key.delete) { setEditDraft((d) => d.slice(0, -1)); return; }
      const cleaned = sanitizePasteInput(input);
      if (cleaned) setEditDraft((d) => d + cleaned);
      return;
    }

    // mode === 'wizard'
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(EDITABLE_ROWS.length - 1, c + 1));
    else if (input === 'e') {
      const row = EDITABLE_ROWS[cursor];
      if (row === 'found') return; // not editable
      setEditing(row);
      setEditDraft(row === 'runner' ? draftRunner : row === 'glob' ? draftGlob : '');
      setMode('editing');
    } else if (input === 'v') {
      const row = EDITABLE_ROWS[cursor];
      if (row === 'found') { setViewCursor(0); setMode('viewing'); }
    } else if (key.return) {
      accept();
    } else if (input === 'q' || key.escape) {
      process.exit(0);
    }
  });

  // Sync 'editing' state to mode ivar
  useEffect(() => {
    if (editing && mode !== 'editing') setMode('editing');
    if (!editing && mode === 'editing') setMode('wizard');
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (mode === 'scanning') {
    return (
      <Frame title="first-run setup" accent={SCREEN_ACCENT.onboarding} subtitle="scanning…"
        footer={<Text color="gray">reading package.json · pyproject · Makefile · probing test dirs…</Text>}>
        <Row label="Target">
          <Text color="white">{targetDir}</Text>
        </Row>
        <Row label="Config dir">
          <Text color="gray">{configDir}</Text>
        </Row>
        <Box marginTop={1}>
          <Text color="#eab308"><Spinner type="dots" /> deterministic scan…</Text>
        </Box>
      </Frame>
    );
  }

  if (mode === 'error') {
    return (
      <Frame title="first-run setup" accent="#ef4444" subtitle="scan failed"
        footer={<Text color="gray">press q to quit</Text>}>
        <Text color="#ef4444" bold>Scan failed:</Text>
        <Text color="white">{errorMsg}</Text>
      </Frame>
    );
  }

  if (mode === 'viewing') {
    return <ViewMatchedFiles files={matched} cursor={viewCursor} />;
  }

  const zeroFound = matched.length === 0;
  const acceptable = !zeroFound && draftRunner.trim().length > 0 && !matching;

  return (
    <Frame
      title="first-run setup"
      accent={SCREEN_ACCENT.onboarding}
      subtitle="scan complete · confirm and continue"
      footer={
        editing ? (
          <Text color="cyan">
            {editing === 'runner' ? 'Runner: ' : 'Glob: '}
            <Text color="white" bold>{editDraft}</Text>
            <Text color="gray">▏</Text>
            <Text color="gray"> · enter save · esc cancel</Text>
          </Text>
        ) : (
          <Text color="gray">
            <Text color="cyan">↑↓</Text> nav · <Text color="cyan">e</Text> edit · <Text color="cyan">v</Text> view (Found) · {acceptable
              ? <Text color="#22c55e" bold>enter accept →</Text>
              : <Text dimColor>enter (blocked{zeroFound ? ': 0 files' : matching ? ': matching…' : ''})</Text>}
            <Text color="gray"> · </Text><Text color="cyan">q</Text> quit
          </Text>
        )
      }
    >
      <Row label="Target">
        <Text color="white">{targetDir}</Text>
      </Row>
      <Row label="Config dir">
        <Text color="gray" dimColor>{configDir}</Text>
      </Row>
      <Box marginTop={1} />

      <FieldRow
        cursor={cursor} index={0}
        label={ROW_LABELS.runner}
        value={<Text color="white">{draftRunner}</Text>}
        meta={<Text color="gray" dimColor>detected from {detectedFrom}</Text>}
        action="[e]dit"
        actionEnabled
      />
      <FieldRow
        cursor={cursor} index={1}
        label={ROW_LABELS.glob}
        value={<Text color="white">{draftGlob || '(none)'}</Text>}
        meta={
          isGlob(draftGlob)
            ? <Text color="gray" dimColor>full glob</Text>
            : <Text color="gray" dimColor>plain path → expanded: {expandGlob(draftGlob)}</Text>
        }
        action="[e]dit"
        actionEnabled
      />
      <FieldRow
        cursor={cursor} index={2}
        label={ROW_LABELS.found}
        value={
          matching
            ? <Text color="#eab308"><Spinner type="dots" /> matching…</Text>
            : zeroFound
              ? <Text color="#ef4444" bold>0 test files ⚠ edit glob to fix</Text>
              : <Text color="white">{matched.length} test files</Text>
        }
        meta={zeroFound ? null : <Text color="gray" dimColor>{matched.slice(0, 2).map((f) => f.relative).join(', ')}{matched.length > 2 ? `, +${matched.length - 2}` : ''}</Text>}
        action="[v]iew"
        actionEnabled={!zeroFound}
      />
    </Frame>
  );
}

function inferDetectedFrom(source: string): Config['runner']['detectedFrom'] {
  if (source.startsWith('package.json')) return 'package.json';
  if (source.startsWith('pyproject')) return 'pyproject.toml';
  if (source.startsWith('Makefile')) return 'Makefile';
  return 'user';
}

function sanitizePasteInput(input: string): string {
  if (!input) return '';
  return input
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={14}><Text color="gray">{label}</Text></Box>
      <Box>{children}</Box>
    </Box>
  );
}

function FieldRow({
  cursor, index, label, value, meta, action, actionEnabled,
}: {
  cursor: number; index: number;
  label: string; value: React.ReactNode; meta: React.ReactNode;
  action: string; actionEnabled: boolean;
}) {
  const active = cursor === index;
  return (
    <Box>
      <Box width={3}>
        {active ? <Text color="cyan" bold>▸ </Text> : <Text>  </Text>}
      </Box>
      <Box width={14}>
        <Text color={active ? 'white' : 'gray'} bold={active}>{label}</Text>
      </Box>
      <Box width={54} flexShrink={0}>{value}</Box>
      <Box width={20}>
        <Text color={actionEnabled ? (active ? 'cyan' : 'gray') : '#3f3f46'} dimColor={!active}>
          {action}
        </Text>
      </Box>
      <Box flexGrow={1}>{meta}</Box>
    </Box>
  );
}

function ViewMatchedFiles({ files, cursor }: { files: MatchedFile[]; cursor: number }) {
  const windowSize = 20;
  const start = Math.max(0, Math.min(files.length - windowSize, cursor - Math.floor(windowSize / 2)));
  const end = Math.min(files.length, start + windowSize);
  return (
    <Frame
      title="matched files"
      accent={SCREEN_ACCENT.onboarding}
      subtitle={`${files.length} files`}
      footer={<Text color="gray"><Text color="cyan">↑↓</Text> scroll · <Text color="cyan">b</Text> back · <Text color="cyan">esc</Text> back</Text>}
    >
      {start > 0 && <Text color="gray" dimColor>  … +{start} above</Text>}
      {files.slice(start, end).map((f, i) => {
        const absIdx = start + i;
        const active = absIdx === cursor;
        return (
          <Box key={f.absolute}>
            <Box width={3}>{active ? <Text color="cyan" bold>▸ </Text> : <Text>  </Text>}</Box>
            <Text color={active ? 'white' : 'gray'} bold={active}>{f.relative}</Text>
          </Box>
        );
      })}
      {end < files.length && <Text color="gray" dimColor>  … +{files.length - end} below</Text>}
    </Frame>
  );
}
