// Unit test for src/proxy/providers.ts — registry lookup, env precedence,
// URL template resolution. Isolated from ~/.c1/.env via a temp HOME.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

async function main() {
  // Sandbox HOME before importing the module, so HOME_ENV_PATH points at a
  // temp dir instead of the user's real ~/.c1/.env.
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-providers-test-'));
  process.env.HOME = tmpHome;
  await fs.mkdir(path.join(tmpHome, '.c1'), { recursive: true });

  const canaryoneDir = new URL('..', import.meta.url).pathname;
  const providers = await import(
    pathToFileURL(path.join(canaryoneDir, 'src/proxy/providers.ts')).href
  );

  // ---------- listAllProviders ----------
  const all = providers.listAllProviders();
  const routerCount = all.filter((p) => p.kind === 'router').length;
  const directCount = all.filter((p) => p.kind === 'direct').length;
  assert(routerCount === 4, `expected 4 routers, got ${routerCount}`);
  assert(directCount === 8, `expected 8 direct providers, got ${directCount}`);

  // ---------- getProvider — router variants ----------
  const or1 = providers.getProvider('openrouter');
  const or2 = providers.getProvider('openrouter:baseten/fp8');
  assert(or1?.slug === 'openrouter' && or2?.slug === 'openrouter',
    'openrouter lookup by bare slug and by destination slug both resolve');

  const v = providers.getProvider('vercel:openai/gpt-oss-120b');
  assert(v?.kind === 'router' && v?.slug === 'vercel', 'vercel destination resolves to vercel router');
  assert(v?.primaryEnv === 'AI_GATEWAY_API_KEY',
    `vercel primaryEnv should be AI_GATEWAY_API_KEY, got ${v?.primaryEnv}`);
  assert(v?.forwardUrlTemplate === 'https://ai-gateway.vercel.sh/v1/chat/completions',
    `vercel forwardUrl should use ai-gateway.vercel.sh, got ${v?.forwardUrlTemplate}`);

  const cf = providers.getProvider('cloudflare');
  assert(cf?.slug === 'cloudflare' && cf?.extraEnvs.includes('CLOUDFLARE_ACCOUNT_ID'),
    'cloudflare requires CLOUDFLARE_ACCOUNT_ID as extra env');
  assert(cf?.primaryEnv === 'CLOUDFLARE_API_TOKEN',
    `cloudflare primaryEnv should be CLOUDFLARE_API_TOKEN, got ${cf?.primaryEnv}`);
  assert(cf?.catalogNeedsAuth === true, 'cloudflare catalog requires auth');

  const bedrock = providers.getProvider('bedrock');
  assert(bedrock?.status === 'coming-soon', 'bedrock is coming-soon');

  // ---------- getProvider — direct variants ----------
  const moon = providers.getProvider('direct:moonshot-intl');
  assert(moon?.kind === 'direct' && moon?.primaryEnv === 'MOONSHOT_API_KEY',
    'moonshot-intl direct resolves with MOONSHOT_API_KEY');
  const moonCn = providers.getProvider('direct:moonshot-cn');
  assert(moonCn?.primaryEnv === 'MOONSHOT_API_KEY',
    'moonshot-cn shares MOONSHOT_API_KEY with intl');
  assert(moon.forwardUrl !== moonCn.forwardUrl,
    'moonshot intl and cn keep distinct forward URLs');

  const unknown = providers.getProvider('direct:not-a-real-provider');
  assert(unknown === undefined, 'unknown direct slug returns undefined');

  const unknownRouter = providers.getProvider('nope:foo');
  assert(unknownRouter === undefined, 'unknown router prefix returns undefined');

  // ---------- getRouterMeta ----------
  const rm = providers.getRouterMeta('openrouter');
  assert(rm?.slug === 'openrouter', 'getRouterMeta(openrouter) works');
  assert(providers.getRouterMeta('direct') === undefined,
    "getRouterMeta('direct') returns undefined — not a router");

  // ---------- readEnv precedence: process.env > dotenv ----------
  const envPath = path.join(tmpHome, '.c1', '.env');
  await fs.writeFile(envPath,
    'OPENROUTER_API_KEY=or-from-dotenv\n' +
    'MOONSHOT_API_KEY="msk-from-dotenv"\n' +
    '# comment line\n' +
    'AI_GATEWAY_API_KEY=vgk-from-dotenv\n');

  delete process.env.OPENROUTER_API_KEY;
  const dotenvHit = await providers.readEnv('OPENROUTER_API_KEY');
  assert(dotenvHit.value === 'or-from-dotenv' && dotenvHit.source === 'dotenv',
    `dotenv read should return value + source=dotenv, got ${JSON.stringify(dotenvHit)}`);

  process.env.OPENROUTER_API_KEY = 'or-from-process';
  const processHit = await providers.readEnv('OPENROUTER_API_KEY');
  assert(processHit.value === 'or-from-process' && processHit.source === 'env',
    `process.env should win over dotenv, got ${JSON.stringify(processHit)}`);
  delete process.env.OPENROUTER_API_KEY;

  // Quotes stripped from dotenv values.
  const quoted = await providers.readEnv('MOONSHOT_API_KEY');
  assert(quoted.value === 'msk-from-dotenv',
    `dotenv quotes should be stripped, got ${JSON.stringify(quoted)}`);

  const missing = await providers.readEnv('NEBIUS_API_KEY');
  assert(missing.value === null && missing.source === null,
    'missing env → null value + null source');

  // ---------- getApiKey by provider slug ----------
  const orKey = await providers.getApiKey('openrouter');
  assert(orKey.value === 'or-from-dotenv', 'getApiKey(openrouter) reads dotenv');

  const moonKey = await providers.getApiKey('direct:moonshot-intl');
  assert(moonKey.value === 'msk-from-dotenv', 'getApiKey(direct:moonshot-intl) reads dotenv');

  const noSuch = await providers.getApiKey('direct:not-real');
  assert(noSuch.value === null && noSuch.source === null,
    'getApiKey on unknown provider → null/null');

  // ---------- resolveUrlTemplate ----------
  // No placeholders — passthrough.
  const straight = await providers.resolveUrlTemplate('https://openrouter.ai/api/v1/credits');
  assert(straight === 'https://openrouter.ai/api/v1/credits', 'no-placeholder template passthrough');

  // CF placeholder — resolves when env is set.
  await fs.appendFile(envPath, 'CLOUDFLARE_ACCOUNT_ID=abc123\n');
  const cfUrl = await providers.resolveUrlTemplate(
    'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/models/search');
  assert(cfUrl === 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/models/search',
    `resolved CF url wrong: ${cfUrl}`);

  // Placeholder can't be filled → null (surface as partial config).
  const bad = await providers.resolveUrlTemplate(
    'https://api.example.com/{NOT_SET_XYZ}/foo');
  assert(bad === null, 'unresolved placeholder returns null');

  // ---------- DIRECT_PRICING shape ----------
  const p = providers.DIRECT_PRICING['direct:moonshot-intl']?.['moonshotai/kimi-k3'];
  assert(p?.input === 2.50 && p?.output === 12.50,
    `moonshot-intl kimi-k3 pricing wrong: ${JSON.stringify(p)}`);
  const missPrice = providers.DIRECT_PRICING['direct:fireworks']?.['moonshotai/kimi-k3'];
  assert(missPrice === undefined,
    'missing (provider, model) pair returns undefined — computeCost fail-soft');

  await fs.rm(tmpHome, { recursive: true, force: true });
  console.log('providers.test.mjs — all assertions passed');
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
