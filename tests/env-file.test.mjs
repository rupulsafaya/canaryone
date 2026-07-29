// Unit test for src/scan/env-file.ts — read/write/delete round-trip with
// comment + ordering preservation.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-envfile-test-'));
  const envPath = path.join(tmpDir, '.env');

  const canaryoneDir = new URL('..', import.meta.url).pathname;
  const envFile = await import(
    pathToFileURL(path.join(canaryoneDir, 'src/scan/env-file.ts')).href
  );

  // ---------- read: missing file → empty ----------
  const empty = await envFile.readEnvFile(envPath);
  assert(empty.entries.length === 0 && empty.raw === '',
    'missing file returns empty result');

  // ---------- write: creates file, single key ----------
  await envFile.writeEnvVar('OPENROUTER_API_KEY', 'sk-or-abc', envPath);
  const after1 = await envFile.readEnvFile(envPath);
  assert(after1.map.OPENROUTER_API_KEY === 'sk-or-abc',
    `write+read round-trip failed: ${JSON.stringify(after1.map)}`);
  assert(after1.raw === 'OPENROUTER_API_KEY=sk-or-abc\n',
    `unexpected file content: ${JSON.stringify(after1.raw)}`);

  // Mode 0o600.
  const st = await fs.stat(envPath);
  assert((st.mode & 0o777) === 0o600, `expected mode 0o600, got ${(st.mode & 0o777).toString(8)}`);

  // ---------- write: append second key preserves first ----------
  await envFile.writeEnvVar('MOONSHOT_API_KEY', 'msk-xyz', envPath);
  const after2 = await envFile.readEnvFile(envPath);
  assert(after2.entries.length === 2, `expected 2 entries, got ${after2.entries.length}`);
  assert(after2.entries[0].key === 'OPENROUTER_API_KEY'
      && after2.entries[1].key === 'MOONSHOT_API_KEY',
    'first-appearance ordering broken after append');

  // ---------- update in-place preserves position ----------
  // Add a third, then update the second — the second should stay in position 2.
  await envFile.writeEnvVar('NEBIUS_API_KEY', 'nbk-1', envPath);
  await envFile.writeEnvVar('MOONSHOT_API_KEY', 'msk-updated', envPath);
  const after3 = await envFile.readEnvFile(envPath);
  assert(after3.entries[1].key === 'MOONSHOT_API_KEY'
      && after3.entries[1].value === 'msk-updated',
    'in-place update should preserve position');
  assert(after3.entries[2].key === 'NEBIUS_API_KEY',
    'append should not have shifted after update');

  // ---------- comment preservation ----------
  // Manually inject comments + blank lines, verify readback + subsequent
  // writes leave them intact.
  const withComments = `# canaryone tokens
OPENROUTER_API_KEY=sk-or-abc

# moonshot pair (shared key)
MOONSHOT_API_KEY=msk-updated

# nebius
NEBIUS_API_KEY=nbk-1
`;
  await fs.writeFile(envPath, withComments);
  await envFile.writeEnvVar('GROQ_API_KEY', 'gsk-1', envPath);
  const readBack = await fs.readFile(envPath, 'utf8');
  assert(readBack.includes('# canaryone tokens'), 'top comment lost');
  assert(readBack.includes('# moonshot pair (shared key)'), 'inline comment lost');
  assert(readBack.includes('# nebius'), 'trailing comment lost');
  assert(readBack.includes('GROQ_API_KEY=gsk-1'), 'appended key missing');
  // GROQ should be appended AFTER all existing content.
  const groqIx = readBack.indexOf('GROQ_API_KEY');
  const nebiusIx = readBack.indexOf('NEBIUS_API_KEY');
  assert(groqIx > nebiusIx, 'append landed before existing keys');

  // Update an existing key mid-file — comments around it must survive.
  await envFile.writeEnvVar('MOONSHOT_API_KEY', 'msk-final', envPath);
  const readBack2 = await fs.readFile(envPath, 'utf8');
  assert(readBack2.includes('# moonshot pair (shared key)'),
    'comment neighboring the updated key was destroyed');
  assert(readBack2.includes('MOONSHOT_API_KEY=msk-final'), 'update did not land');

  // ---------- quote handling ----------
  await envFile.writeEnvVar('WITH_SPACES', 'hello world', envPath);
  const quotedContent = await fs.readFile(envPath, 'utf8');
  assert(quotedContent.includes('WITH_SPACES="hello world"'),
    `value with spaces should be quoted, got file:\n${quotedContent}`);
  // Reader must strip quotes.
  const parsed = await envFile.readEnvFile(envPath);
  assert(parsed.map.WITH_SPACES === 'hello world',
    `quoted value not unquoted on read: ${JSON.stringify(parsed.map.WITH_SPACES)}`);

  // Passing a pre-quoted value strips the outer pair before storing.
  await envFile.writeEnvVar('PREQUOTED', '"already-quoted"', envPath);
  const preParsed = await envFile.readEnvFile(envPath);
  assert(preParsed.map.PREQUOTED === 'already-quoted',
    `outer quotes should be stripped before write, got ${JSON.stringify(preParsed.map.PREQUOTED)}`);

  // ---------- readEnvValue convenience ----------
  const v1 = await envFile.readEnvValue('OPENROUTER_API_KEY', envPath);
  assert(v1 === 'sk-or-abc', `readEnvValue got ${v1}`);
  const v2 = await envFile.readEnvValue('MISSING_KEY', envPath);
  assert(v2 === null, 'readEnvValue on missing key should return null');

  // ---------- writeEnvVars bulk ----------
  await envFile.writeEnvVars({
    CLOUDFLARE_API_TOKEN: 'cf-tok',
    CLOUDFLARE_ACCOUNT_ID: 'cf-acct-123',
  }, envPath);
  const bulk = await envFile.readEnvFile(envPath);
  assert(bulk.map.CLOUDFLARE_API_TOKEN === 'cf-tok'
      && bulk.map.CLOUDFLARE_ACCOUNT_ID === 'cf-acct-123',
    'writeEnvVars bulk did not persist all keys');

  // ---------- delete ----------
  await envFile.deleteEnvVar('WITH_SPACES', envPath);
  const afterDelete = await envFile.readEnvFile(envPath);
  assert(!('WITH_SPACES' in afterDelete.map), 'deleted key still present');
  // Comments around unrelated keys survive delete.
  const rawAfterDel = await fs.readFile(envPath, 'utf8');
  assert(rawAfterDel.includes('# canaryone tokens'), 'delete wiped unrelated comment');

  // delete a non-existent key is a no-op (no throw).
  await envFile.deleteEnvVar('NOT_HERE', envPath);

  // ---------- deleteEnvVars bulk ----------
  await envFile.deleteEnvVars(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], envPath);
  const afterBulkDel = await envFile.readEnvFile(envPath);
  assert(!('CLOUDFLARE_API_TOKEN' in afterBulkDel.map)
      && !('CLOUDFLARE_ACCOUNT_ID' in afterBulkDel.map),
    'bulk delete did not remove both keys');

  // ---------- invalid key ----------
  let threw = false;
  try {
    await envFile.writeEnvVar('has-dash', 'x', envPath);
  } catch {
    threw = true;
  }
  assert(threw, 'invalid key name should throw');

  // ---------- inline comment on a bare value ----------
  await fs.writeFile(envPath, 'FOO=bare-value # trailing comment\nBAR=other\n');
  const inline = await envFile.readEnvFile(envPath);
  assert(inline.map.FOO === 'bare-value',
    `inline comment should be stripped from bare value, got ${JSON.stringify(inline.map.FOO)}`);
  assert(inline.map.BAR === 'other', 'unrelated key broken by inline-comment stripping');

  // Quoted value with `#` inside must NOT be treated as a comment.
  await fs.writeFile(envPath, 'HASHVAL="value#with#hash"\n');
  const hashed = await envFile.readEnvFile(envPath);
  assert(hashed.map.HASHVAL === 'value#with#hash',
    `quoted # should be preserved, got ${JSON.stringify(hashed.map.HASHVAL)}`);

  // ---------- atomic write: no tmp files left over ----------
  const dirFiles = await fs.readdir(tmpDir);
  const stray = dirFiles.filter((f) => f.startsWith('.env.tmp-'));
  assert(stray.length === 0, `atomic tmp files left behind: ${stray.join(', ')}`);

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('env-file.test.mjs — all assertions passed');
}

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERT FAIL:', msg);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
