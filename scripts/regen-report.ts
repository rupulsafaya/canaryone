// Regenerate the HTML report for an existing run — no runner, no proxy.
//
// Usage:
//   tsx scripts/regen-report.ts <configDir> <runId>
//
// Example:
//   tsx scripts/regen-report.ts /Users/rupulsafaya/Documents/GitHub/canaryone-demo/.c1 e860167a-2cfb-4415-a19c-86b476b2a1d6

import { generate } from '../src/report/generate.ts';

async function main() {
  const [, , configDir, runId] = process.argv;
  if (!configDir || !runId) {
    console.error('usage: tsx scripts/regen-report.ts <configDir> <runId>');
    process.exit(2);
  }
  try {
    const outPath = await generate(runId, configDir);
    console.log(outPath);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
main();
