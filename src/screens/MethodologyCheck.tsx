import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useStore } from '../state/store.js';
import { SCREEN_ACCENT } from '../data/colors.js';
import { Frame } from '../components/Frame.tsx';
import { METHODOLOGY_MODEL, knownSdkList } from '../scan/methodology.js';

export function MethodologyCheck() {
  const goTo = useStore((s) => s.goTo);
  const status = useStore((s) => s.methodologyStatus);
  const report = useStore((s) => s.methodology);
  const error = useStore((s) => s.methodologyError);
  const load = useStore((s) => s.loadMethodology);
  const force = useStore((s) => s.forceRescanMethodology);

  useEffect(() => {
    // Fire the check on mount. force flag comes from --rescan-methodology.
    void load(force);
    // Reset the force flag so a subsequent screen visit uses the cache.
    if (force) useStore.setState({ forceRescanMethodology: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (status === 'loading') {
      if (input === 'q' || key.escape) process.exit(0);
      return;
    }
    if (status === 'blocked') {
      if (input === 'q' || key.escape) process.exit(1);
      return;
    }
    if (status === 'error') {
      if (input === 'r') void load(true);
      else if (input === 'q' || key.escape) process.exit(1);
      return;
    }
    // ready: user reviews the verdict, then Enter advances.
    if (key.return) goTo('pickTasks');
    else if (input === 'r') void load(true);   // manual re-scan
    else if (input === 'q' || key.escape) process.exit(0);
  });

  const subtitle =
    status === 'loading' ? `analyzing with ${METHODOLOGY_MODEL}…`
      : status === 'ready' ? 'proxy will intercept'
        : status === 'blocked' ? 'canaryone cannot intercept this codebase'
          : status === 'error' ? 'methodology scan failed'
            : ' ';

  return (
    <Frame
      title="Methodology"
      accent={SCREEN_ACCENT.pickTasks}
      subtitle={subtitle}
      footer={<Footer status={status} />}
    >
      <Text color="gray">
        canaryone works by swapping <Text color="white">*_BASE_URL</Text> env vars so a lane proxy can intercept your codebase's LLM calls.
      </Text>
      <Text color="gray" dimColor>~$0.001 · cached to .c1/config.json (invalidated on source change)</Text>
      <Box marginTop={1} />

      {status === 'idle' && (
        <Text color="gray">preparing…</Text>
      )}

      {status === 'loading' && (
        <Text color="#eab308">
          <Spinner type="dots" /> analyzing how this codebase calls LLMs…
        </Text>
      )}

      {status === 'ready' && report && <ReadyView report={report} />}

      {status === 'blocked' && report?.state === 'sdk-hardcoded' && (
        <BlockedHardcoded report={report} />
      )}

      {status === 'blocked' && report?.state === 'no-sdk-detected' && (
        <BlockedNoSdk report={report} />
      )}

      {status === 'error' && (
        <Box flexDirection="column">
          <Text color="#ef4444" bold>✗ methodology scan failed</Text>
          <Text color="gray">{error ?? 'unknown error'}</Text>
        </Box>
      )}
    </Frame>
  );
}

function ReadyView({ report }: { report: NonNullable<ReturnType<typeof useStore.getState>['methodology']> }) {
  const stateLabel = report.state === 'sdk-env' ? 'SDK default / env-var base URL' : 'config-value base URL (traces to env)';
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="#22c55e" bold>✓ Detected </Text>
        <Text color="white" bold>{report.primarySdk ?? '(known SDK)'}</Text>
        {report.otherSdks.length > 0 && (
          <Text color="gray"> · also: {report.otherSdks.join(', ')}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Mode: </Text>
        <Text color="white">{stateLabel}</Text>
      </Box>
      {report.evidence && (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Evidence:</Text>
          <Box paddingLeft={2}><Text color="white">{report.evidence}</Text></Box>
        </Box>
      )}
      {report.followedFiles.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Walked {report.followedFiles.length} file{report.followedFiles.length === 1 ? '' : 's'}:</Text>
          <Box paddingLeft={2} flexDirection="column">
            {report.followedFiles.slice(0, 6).map((f, i) => (
              <Text key={i} color="gray" dimColor>· {f}</Text>
            ))}
            {report.followedFiles.length > 6 && (
              <Text color="gray" dimColor>… +{report.followedFiles.length - 6} more</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function BlockedHardcoded({ report }: { report: NonNullable<ReturnType<typeof useStore.getState>['methodology']> }) {
  const sites = report.hardcodedSites ?? [];
  return (
    <Box flexDirection="column">
      <Text color="#ef4444" bold>✗ base URL is hardcoded — proxy cannot intercept</Text>
      <Box marginTop={1}>
        <Text color="white" bold>{report.primarySdk ?? '(SDK)'}</Text>
        <Text color="gray"> is imported, but the base URL is a string literal.</Text>
      </Box>
      {report.evidence && (
        <Box marginTop={1}><Text color="gray">{report.evidence}</Text></Box>
      )}
      {sites.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">Hardcoded sites:</Text>
          {sites.slice(0, 8).map((s, i) => (
            <Box key={i} flexDirection="column" paddingLeft={2} marginTop={1}>
              <Box>
                <Text color="white" bold>{s.file}</Text>
                {s.line != null && <Text color="gray">:{s.line}</Text>}
              </Box>
              <Box paddingLeft={2}>
                <Text color="#ef4444">literal: </Text>
                <Text color="white">{s.literal}</Text>
              </Box>
              <Box paddingLeft={2}>
                <Text color="#22c55e">fix: read from </Text>
                <Text color="white" bold>process.env.{s.suggestedEnvVar}</Text>
                <Text color="gray"> (fall back to the literal for defaults)</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray" dimColor>Edit your code, then rerun </Text>
        <Text color="white">c1 --rescan-methodology</Text>
      </Box>
    </Box>
  );
}

function BlockedNoSdk({ report }: { report: NonNullable<ReturnType<typeof useStore.getState>['methodology']> }) {
  return (
    <Box flexDirection="column">
      <Text color="#ef4444" bold>✗ no recognized SDK detected</Text>
      <Box marginTop={1}>
        <Text color="gray">canaryone supports codebases that use one of these SDKs:</Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column" marginTop={1}>
        {knownSdkList().slice(0, 16).map((s, i) => (
          <Text key={i} color="white">· {s}</Text>
        ))}
      </Box>
      {report.evidence && (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">What we saw:</Text>
          <Box paddingLeft={2}><Text color="white">{report.evidence}</Text></Box>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray" dimColor>Add a supported SDK import to your agent, then </Text>
        <Text color="white">c1 --rescan-methodology</Text>
      </Box>
    </Box>
  );
}

function Footer({ status }: { status: string }) {
  if (status === 'loading') {
    return <Text color="gray">please wait · <Text color="cyan">q</Text> quit</Text>;
  }
  if (status === 'ready') {
    return (
      <Text color="gray">
        <Text color="#22c55e" bold>enter continue →</Text>
        <Text color="gray"> · </Text>
        <Text color="cyan">r</Text> re-scan · <Text color="cyan">q</Text> quit
      </Text>
    );
  }
  if (status === 'blocked') {
    return (
      <Text color="gray">
        <Text color="cyan">r</Text> re-scan (after fixing code) · <Text color="cyan">q</Text> quit
      </Text>
    );
  }
  if (status === 'error') {
    return (
      <Text color="gray">
        <Text color="cyan">r</Text> retry · <Text color="cyan">q</Text> quit
      </Text>
    );
  }
  return <Text color="gray"><Text color="cyan">q</Text> quit</Text>;
}
