import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import {
  ROUTERS,
  DIRECT_PROVIDERS,
  readEnv,
  resolveUrlTemplate,
  getProvider,
  type RouterEntry,
  type DirectEntry,
  type EnvSource,
} from '../proxy/providers.js';
import { writeEnvVar, writeEnvVars, deleteEnvVars, HOME_ENV_PATH_FOR_TESTS } from '../scan/env-file.js';

// One row per unique primary env var. moonshot-intl + moonshot-cn share
// MOONSHOT_API_KEY, so they collapse into a single row labelled
// "Moonshot (intl + cn)".
interface RowSpec {
  id: string;                          // stable key: primaryEnv
  group: 'Routers' | 'Direct Providers';
  displayName: string;
  primaryEnv: string;
  extraEnvs: string[];
  status: 'shipped' | 'coming-soon';
  /** The provider entry used for validation + catalog refresh calls. */
  representativeSlug: string;
}

type RowStatus =
  | { kind: 'missing' }
  | { kind: 'partial'; missingEnv: string }
  | { kind: 'set'; source: EnvSource }
  | { kind: 'set-validated'; source: EnvSource; validatedAtMs: number; credits?: number | null }
  | { kind: 'set-unverified'; source: EnvSource; reason: string }
  | { kind: 'set-rejected'; source: EnvSource; error: string }
  | { kind: 'validating' }
  | { kind: 'saving' }
  | { kind: 'catalog-refreshing' };

interface RowState {
  status: RowStatus;
  transient: string | null;            // "fetching catalog…", "refreshing…"
  error: string | null;
}

type Mode =
  | { kind: 'browse' }
  | { kind: 'paste'; row: RowSpec; envName: string; draft: string }
  | { kind: 'paste-cf'; row: RowSpec; step: 'token' | 'accountId'; draft: string; token?: string }
  | { kind: 'confirm-delete'; row: RowSpec };

export function ApiKeys() {
  const goTo = useStore((s) => s.goTo);
  const setOrKey = useStore((s) => s.setOrKey);
  const providerCatalogs = useStore((s) => s.providerCatalogs);
  const orCatalog = useStore((s) => s.orCatalog);
  const loadProviderCatalogs = useStore((s) => s.loadProviderCatalogs);
  const loadCatalog = useStore((s) => s.loadCatalog);
  const resumeFromCache = useStore((s) => s.resumeFromCache);
  const forceWizard = useStore((s) => s.forceWizard);
  const [advancing, setAdvancing] = useState(false);

  const rows = useMemo<RowSpec[]>(() => buildRows(), []);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>(() => initialRowStates(rows));
  const [selectedIx, setSelectedIx] = useState<number>(() => firstNavigableIx(rows));
  const [mode, setMode] = useState<Mode>({ kind: 'browse' });

  // Boot: for each shipped row, resolve current env state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, RowState> = {};
      for (const row of rows) {
        next[row.id] = await computeInitialStatus(row);
      }
      if (!cancelled) setRowStates(next);
    })();
    return () => { cancelled = true; };
  }, [rows]);

  // Prime catalog data so row counts render. Both are cache-first:
  // orCatalog uses ~/.c1/or-catalog.json (24h TTL) and providerCatalogs
  // uses ~/.c1/provider-catalogs.json — no network unless stale.
  useEffect(() => { void loadProviderCatalogs(); }, [loadProviderCatalogs]);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  // Compute per-row model count from whichever catalog owns that provider.
  const modelCounts = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    for (const row of rows) {
      if (row.status !== 'shipped') { out[row.id] = null; continue; }
      if (row.representativeSlug === 'openrouter') {
        out[row.id] = orCatalog?.models.length ?? null;
      } else {
        const cat = providerCatalogs[row.representativeSlug];
        out[row.id] = cat?.models_raw.length ?? null;
      }
    }
    return out;
  }, [rows, providerCatalogs, orCatalog]);

  const patchRow = (id: string, partial: Partial<RowState> | { status: RowStatus }) => {
    setRowStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...partial },
    }));
  };

  const configuredCount = Object.values(rowStates).filter((s) =>
    s.status.kind === 'set'
    || s.status.kind === 'set-validated'
    || s.status.kind === 'set-unverified'
    || s.status.kind === 'set-rejected',
  ).length;
  const totalShipped = rows.filter((r) => r.status === 'shipped').length;

  const orRow = rows.find((r) => r.id === 'OPENROUTER_API_KEY');
  const orRowState = orRow ? rowStates[orRow.id] : undefined;
  const canAdvance = !!orRowState && isRowSet(orRowState.status);

  const validateAndSave = async (
    row: RowSpec,
    values: Record<string, string>,
  ): Promise<void> => {
    patchRow(row.id, { status: { kind: 'validating' }, error: null });

    const provider = getProvider(row.representativeSlug);
    if (!provider) {
      patchRow(row.id, { status: { kind: 'missing' }, error: 'unknown provider (bug)' });
      return;
    }

    // Prime process.env so resolveUrlTemplate sees the freshly-pasted values
    // BEFORE they're written to ~/.c1/.env. Restore + never leak to child
    // processes: the runner reads from ~/.c1/.env directly.
    const originalEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(values)) {
      originalEnv[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const url = await resolveUrlTemplate(provider.validationUrlTemplate);
      const token = values[provider.primaryEnv];
      if (!url || !token) {
        patchRow(row.id, {
          status: { kind: 'missing' },
          error: `could not resolve validation URL for ${row.displayName}`,
        });
        return;
      }

      let result: 'ok' | 'rejected' | 'unverified';
      let reason = '';
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 200) result = 'ok';
        else if (res.status === 401 || res.status === 403) {
          result = 'rejected';
          reason = `HTTP ${res.status}`;
        } else {
          result = 'unverified';
          reason = `HTTP ${res.status}`;
        }
      } catch (e) {
        result = 'unverified';
        reason = e instanceof Error ? e.message : String(e);
      }

      if (result === 'rejected') {
        patchRow(row.id, {
          status: { kind: 'set-rejected', source: 'dotenv', error: reason },
          transient: null,
          error: reason,
        });
        // Restore env — we're NOT saving a rejected token.
        for (const [k, orig] of Object.entries(originalEnv)) {
          if (orig === undefined) delete process.env[k];
          else process.env[k] = orig;
        }
        return;
      }

      // OK or unverified → save to disk.
      patchRow(row.id, { status: { kind: 'saving' } });
      await writeEnvVars(values);

      if (row.id === 'OPENROUTER_API_KEY') {
        setOrKey(true, '~/.c1/.env');
      }

      if (result === 'ok') {
        patchRow(row.id, {
          status: {
            kind: 'set-validated',
            source: 'dotenv',
            validatedAtMs: Date.now(),
            credits: null,
          },
          error: null,
        });
        // Fire-and-forget catalog refresh — don't block the UI on Haiku.
        void triggerCatalogRefresh(row, token, patchRow);
      } else {
        patchRow(row.id, {
          status: { kind: 'set-unverified', source: 'dotenv', reason },
          error: reason,
        });
      }
    } finally {
      // Leave process.env populated on success (subsequent resolveUrlTemplate
      // calls in this session should see the just-saved values). On rejection
      // we've already restored above.
    }
  };

  useInput((input, key) => {
    // ---- browse ----
    if (mode.kind === 'browse') {
      if (input === 'q' || key.escape) process.exit(0);
      if (key.upArrow) {
        setSelectedIx((ix) => stepIx(rows, ix, -1));
        return;
      }
      if (key.downArrow) {
        setSelectedIx((ix) => stepIx(rows, ix, +1));
        return;
      }
      if (key.return) {
        if (!canAdvance || advancing) return;
        setAdvancing(true);
        void (async () => {
          // Skip the wizard when the target has cached scan + config + methodology
          // + at least one included task. --wizard (or the store flag) forces
          // the full flow.
          const resumed = forceWizard ? false : await resumeFromCache();
          setAdvancing(false);
          goTo(resumed ? 'pickRoutes' : 'onboarding');
        })();
        return;
      }
      const row = rows[selectedIx];
      if (!row || row.status !== 'shipped') return;
      const state = rowStates[row.id];

      if (input === 'p') {
        if (row.extraEnvs.length > 0) {
          setMode({ kind: 'paste-cf', row, step: 'token', draft: '' });
        } else {
          setMode({ kind: 'paste', row, envName: row.primaryEnv, draft: '' });
        }
        return;
      }
      if (input === 'd') {
        if (state && isRowSet(state.status)) setMode({ kind: 'confirm-delete', row });
        return;
      }
      if (input === 'r') {
        // Refresh catalog for the highlighted row (needs a token).
        if (state && isRowSet(state.status)) {
          void refreshSingleRow(row, patchRow);
        }
        return;
      }
      if (input === 'R') {
        void refreshAllConfiguredRows(rows, rowStates, patchRow);
        return;
      }
      return;
    }

    // ---- confirm-delete ----
    if (mode.kind === 'confirm-delete') {
      if (input === 'y') {
        const row = mode.row;
        void (async () => {
          const keys = [row.primaryEnv, ...row.extraEnvs];
          await deleteEnvVars(keys);
          for (const k of keys) delete process.env[k];
          patchRow(row.id, { status: { kind: 'missing' }, transient: null, error: null });
          if (row.id === 'OPENROUTER_API_KEY') setOrKey(false, null);
          setMode({ kind: 'browse' });
        })();
        return;
      }
      if (input === 'n' || key.escape) {
        setMode({ kind: 'browse' });
        return;
      }
      return;
    }

    // ---- paste (single-field) ----
    if (mode.kind === 'paste') {
      if (key.escape) { setMode({ kind: 'browse' }); return; }
      if (key.return) {
        const cleaned = cleanPaste(mode.draft);
        if (cleaned.error) {
          patchRow(mode.row.id, { error: cleaned.error });
          setMode({ kind: 'browse' });
          return;
        }
        const row = mode.row;
        void validateAndSave(row, { [mode.envName]: cleaned.value });
        setMode({ kind: 'browse' });
        return;
      }
      if (key.backspace || key.delete) {
        setMode({ ...mode, draft: mode.draft.slice(0, -1) });
        return;
      }
      const cleaned = sanitizeInput(input);
      if (cleaned) setMode({ ...mode, draft: mode.draft + cleaned });
      return;
    }

    // ---- paste-cf (2-step) ----
    if (mode.kind === 'paste-cf') {
      if (key.escape) { setMode({ kind: 'browse' }); return; }
      if (key.return) {
        const cleaned = cleanPaste(mode.draft);
        if (cleaned.error) {
          patchRow(mode.row.id, { error: cleaned.error });
          setMode({ kind: 'browse' });
          return;
        }
        if (mode.step === 'token') {
          setMode({ ...mode, step: 'accountId', draft: '', token: cleaned.value });
          return;
        }
        // step === 'accountId' — commit both values.
        const row = mode.row;
        const values: Record<string, string> = {
          [row.primaryEnv]: mode.token ?? '',
          [row.extraEnvs[0]]: cleaned.value,
        };
        void validateAndSave(row, values);
        setMode({ kind: 'browse' });
        return;
      }
      if (key.backspace || key.delete) {
        setMode({ ...mode, draft: mode.draft.slice(0, -1) });
        return;
      }
      const cleaned = sanitizeInput(input);
      if (cleaned) setMode({ ...mode, draft: mode.draft + cleaned });
      return;
    }
  });

  return (
    <Frame
      title="API keys"
      accent={SCREEN_ACCENT.onboarding}
      subtitle={`${configuredCount} of ${totalShipped} providers configured`}
      footer={<Footer mode={mode} canAdvance={canAdvance} />}
    >
      <Text color="gray">
        Providers are optional except OpenRouter. Add keys for any router or direct provider
        you want in your benchmarks.
      </Text>
      <Box marginTop={1} />

      {mode.kind === 'browse' && (
        <RowList rows={rows} rowStates={rowStates} selectedIx={selectedIx} modelCounts={modelCounts} />
      )}

      {mode.kind === 'paste' && (
        <PastePanel
          title={`Paste ${mode.envName} for ${mode.row.displayName}`}
          draftLen={mode.draft.length}
        />
      )}

      {mode.kind === 'paste-cf' && (
        <PastePanel
          title={mode.step === 'token'
            ? `Paste ${mode.row.primaryEnv} for ${mode.row.displayName}  (step 1 of 2)`
            : `Paste ${mode.row.extraEnvs[0]} for ${mode.row.displayName}  (step 2 of 2)`}
          draftLen={mode.draft.length}
          hint={mode.step === 'accountId' ? 'account_id is not a secret; visible in your CF dashboard.' : undefined}
        />
      )}

      {mode.kind === 'confirm-delete' && (
        <Box flexDirection="column">
          <Text color="#eab308">Remove {mode.row.primaryEnv}
            {mode.row.extraEnvs.length ? ` + ${mode.row.extraEnvs.join(' + ')}` : ''}
            {' '}from {HOME_ENV_PATH_FOR_TESTS}?</Text>
          <Text color="gray">[y] confirm  [n] cancel</Text>
        </Box>
      )}
    </Frame>
  );
}

// ---------- helpers ----------

function buildRows(): RowSpec[] {
  const out: RowSpec[] = [];

  // Routers group.
  for (const r of ROUTERS) {
    out.push({
      id: r.primaryEnv,
      group: 'Routers',
      displayName: r.displayName,
      primaryEnv: r.primaryEnv,
      extraEnvs: r.extraEnvs,
      status: r.status,
      representativeSlug: r.slug,
    });
  }

  // Direct providers — collapse shared primaryEnv.
  const seenEnv = new Set<string>();
  for (const d of DIRECT_PROVIDERS) {
    if (seenEnv.has(d.primaryEnv)) continue;
    seenEnv.add(d.primaryEnv);
    // Group Moonshot intl + cn under one visible name.
    const displayName = d.primaryEnv === 'MOONSHOT_API_KEY' ? 'Moonshot (intl + cn)' : d.displayName;
    out.push({
      id: d.primaryEnv,
      group: 'Direct Providers',
      displayName,
      primaryEnv: d.primaryEnv,
      extraEnvs: d.extraEnvs,
      status: d.status,
      representativeSlug: d.slug,
    });
  }
  return out;
}

function initialRowStates(rows: RowSpec[]): Record<string, RowState> {
  const out: Record<string, RowState> = {};
  for (const row of rows) {
    out[row.id] = {
      status: row.status === 'coming-soon' ? { kind: 'missing' } : { kind: 'missing' },
      transient: null,
      error: null,
    };
  }
  return out;
}

async function computeInitialStatus(row: RowSpec): Promise<RowState> {
  if (row.status !== 'shipped') return { status: { kind: 'missing' }, transient: null, error: null };
  const primary = await readEnv(row.primaryEnv);
  if (!primary.value) {
    return { status: { kind: 'missing' }, transient: null, error: null };
  }
  if (row.extraEnvs.length > 0) {
    for (const extra of row.extraEnvs) {
      const e = await readEnv(extra);
      if (!e.value) {
        return {
          status: { kind: 'partial', missingEnv: extra },
          transient: null,
          error: null,
        };
      }
    }
  }
  return {
    status: { kind: 'set', source: primary.source ?? 'dotenv' },
    transient: null,
    error: null,
  };
}

function firstNavigableIx(rows: RowSpec[]): number {
  const ix = rows.findIndex((r) => r.status === 'shipped');
  return ix >= 0 ? ix : 0;
}

function stepIx(rows: RowSpec[], from: number, dir: -1 | 1): number {
  let i = from;
  for (let n = 0; n < rows.length; n++) {
    i = (i + dir + rows.length) % rows.length;
    if (rows[i].status === 'shipped') return i;
  }
  return from;
}

function isRowSet(status: RowStatus): boolean {
  return status.kind === 'set'
    || status.kind === 'set-validated'
    || status.kind === 'set-unverified'
    || status.kind === 'set-rejected';
}

async function triggerCatalogRefresh(
  row: RowSpec,
  token: string,
  patchRow: (id: string, partial: Partial<RowState>) => void,
): Promise<void> {
  patchRow(row.id, { transient: 'fetching catalog…' });
  try {
    // Route through the store so OR canonical slugs get passed to Haiku
    // as alignment targets — without this, per-provider Haiku calls invent
    // divergent canonical forms and PickDestinations misses cross-provider matches.
    const { useStore } = await import('../state/store.js');
    await useStore.getState().refreshProviderCatalog(row.representativeSlug, token);
    patchRow(row.id, { transient: null });
  } catch (e) {
    patchRow(row.id, {
      transient: null,
      error: `catalog refresh failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

async function refreshSingleRow(
  row: RowSpec,
  patchRow: (id: string, partial: Partial<RowState>) => void,
): Promise<void> {
  const token = (await readEnv(row.primaryEnv)).value;
  if (!token) return;
  await triggerCatalogRefresh(row, token, patchRow);
}

async function refreshAllConfiguredRows(
  rows: RowSpec[],
  rowStates: Record<string, RowState>,
  patchRow: (id: string, partial: Partial<RowState>) => void,
): Promise<void> {
  const targets = rows.filter((r) => r.status === 'shipped' && rowStates[r.id] && isRowSet(rowStates[r.id].status));
  await Promise.all(targets.map((row) => refreshSingleRow(row, patchRow)));
}

function cleanPaste(raw: string): { value: string; error: string | null } {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (trimmed.length === 0) return { value: '', error: 'paste is empty' };
  if (/[\r\n]/.test(trimmed)) return { value: '', error: 'paste must be a single-line token' };
  return { value: trimmed, error: null };
}

function sanitizeInput(input: string): string {
  if (!input) return '';
  return input
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

// ---------- Row list rendering ----------

function RowList({
  rows,
  rowStates,
  selectedIx,
  modelCounts,
}: {
  rows: RowSpec[];
  rowStates: Record<string, RowState>;
  selectedIx: number;
  modelCounts: Record<string, number | null>;
}) {
  const routers = rows.filter((r) => r.group === 'Routers');
  const directs = rows.filter((r) => r.group === 'Direct Providers');
  return (
    <Box flexDirection="column">
      <Text color="#94a3b8" bold>Routers</Text>
      {routers.map((row) => {
        const ix = rows.indexOf(row);
        return <Row key={row.id} row={row} state={rowStates[row.id]} selected={ix === selectedIx} count={modelCounts[row.id]} />;
      })}
      <Box marginTop={1} />
      <Text color="#94a3b8" bold>Direct Providers</Text>
      {directs.map((row) => {
        const ix = rows.indexOf(row);
        return <Row key={row.id} row={row} state={rowStates[row.id]} selected={ix === selectedIx} count={modelCounts[row.id]} />;
      })}
      <Text color="gray" dimColor>  More coming soon</Text>
    </Box>
  );
}

function Row({
  row,
  state,
  selected,
  count,
}: {
  row: RowSpec;
  state: RowState | undefined;
  selected: boolean;
  count: number | null | undefined;
}) {
  const cursor = selected ? '▸' : ' ';
  const isGrey = row.status !== 'shipped';
  const nameColor = isGrey ? 'gray' : selected ? '#f472b6' : 'white';
  const status = state?.status ?? { kind: 'missing' as const };
  const countLabel = renderCountLabel(count, status);

  return (
    <Box>
      <Box width={2}><Text color="#f472b6">{cursor}</Text></Box>
      <Box width={28}><Text color={nameColor} dimColor={isGrey}>{row.displayName}</Text></Box>
      <Box width={22}>{renderStatusBadge(status, row)}</Box>
      <Box width={14}>{countLabel}</Box>
      <Box flexGrow={1}>{renderStatusTail(status, row, state)}</Box>
    </Box>
  );
}

function renderCountLabel(
  count: number | null | undefined,
  status: RowStatus,
): React.ReactNode {
  // Only show counts for rows whose token is present (missing/partial rows
  // haven't fetched their catalog yet — showing a stale OR count would be
  // misleading, and 0 would look like an error).
  const rowIsSet = status.kind === 'set'
    || status.kind === 'set-validated'
    || status.kind === 'set-unverified';
  if (!rowIsSet) return <Text> </Text>;
  if (count == null) return <Text color="gray" dimColor>—</Text>;
  return <Text color="#94a3b8">{count.toLocaleString()} models</Text>;
}

function renderStatusBadge(status: RowStatus, row: RowSpec): React.ReactNode {
  if (row.status === 'coming-soon') return <Text color="gray" dimColor>— coming soon</Text>;
  switch (status.kind) {
    case 'missing':          return <Text color="gray">— missing</Text>;
    case 'partial':          return <Text color="#eab308">— partial config</Text>;
    case 'validating':       return <Text color="#eab308"><Spinner type="dots" /> validating…</Text>;
    case 'saving':           return <Text color="#eab308"><Spinner type="dots" /> saving…</Text>;
    case 'catalog-refreshing': return <Text color="#eab308"><Spinner type="dots" /> refreshing…</Text>;
    case 'set':              return <Text color="#22c55e">✓ set</Text>;
    case 'set-validated':    return <Text color="#22c55e">✓ set · validated</Text>;
    case 'set-unverified':   return <Text color="#eab308">✓ set · unverified</Text>;
    case 'set-rejected':     return <Text color="#ef4444">✗ rejected</Text>;
  }
}

function renderStatusTail(status: RowStatus, row: RowSpec, state: RowState | undefined): React.ReactNode {
  if (row.status === 'coming-soon') return <Text color="gray" dimColor>(grey)</Text>;
  if (state?.transient) return <Text color="gray">{state.transient}</Text>;

  switch (status.kind) {
    case 'missing':
      return <Text color="gray" dimColor>
        [p] paste token
      </Text>;
    case 'partial':
      return <Text color="gray" dimColor>
        [p] paste (needs {row.primaryEnv} + {row.extraEnvs.join(' + ')})
      </Text>;
    case 'set':
    case 'set-validated':
    case 'set-unverified':
    case 'set-rejected': {
      const source = 'source' in status ? status.source : 'dotenv';
      const src = source === 'env' ? `env:$${row.primaryEnv}` : '~/.c1/.env';
      return <Text color="gray" dimColor>({src}{state?.error ? ` · ${state.error.slice(0, 60)}` : ''})</Text>;
    }
    default:
      return null;
  }
}

// ---------- Footer ----------

function Footer({ mode, canAdvance }: { mode: Mode; canAdvance: boolean }) {
  if (mode.kind === 'paste' || mode.kind === 'paste-cf') {
    return (
      <Text color="gray">
        <Text color="#22c55e" bold>enter</Text> save · <Text color="cyan">esc</Text> cancel
      </Text>
    );
  }
  if (mode.kind === 'confirm-delete') {
    return (
      <Text color="gray">
        <Text color="#ef4444" bold>y</Text> confirm · <Text color="cyan">n</Text> cancel
      </Text>
    );
  }
  return (
    <Text color="gray">
      <Text color="cyan">↑↓</Text> nav · <Text color="cyan">p</Text> paste · <Text color="cyan">d</Text> delete · <Text color="cyan">r</Text> refresh · <Text color="cyan">R</Text> refresh all · {' '}
      {canAdvance
        ? <Text color="#22c55e" bold>enter continue →</Text>
        : <Text dimColor>enter (OR required)</Text>}
      <Text color="gray"> · </Text><Text color="cyan">q</Text> quit
    </Text>
  );
}

// Retain the RouterEntry / DirectEntry types in scope so tree-shaking doesn't
// drop them from the imports section above; they're the shape of buildRows'
// inputs.
type _Retain = RouterEntry | DirectEntry;

function PastePanel({ title, draftLen, hint }: { title: string; draftLen: number; hint?: string }) {
  return (
    <Box flexDirection="column">
      <Text color="cyan">{title}</Text>
      <Box marginTop={1}>
        <Box width={8}><Text color="cyan">Value</Text></Box>
        <Text color="white">{'•'.repeat(Math.min(draftLen, 32))}</Text>
        <Text color="gray">▏</Text>
        {draftLen > 0 && <Text color="gray" dimColor>  ({draftLen} chars)</Text>}
      </Box>
      {hint && <Box marginTop={1}><Text color="gray" dimColor>{hint}</Text></Box>}
    </Box>
  );
}
