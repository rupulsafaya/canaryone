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
  assert(routerCount === 3, `expected 3 routers, got ${routerCount}`);
  assert(directCount === 14, `expected 14 direct providers, got ${directCount}`);

  // ---------- Frontier direct providers (added 2026-07-31) ----------
  const openai = providers.getProvider('direct:openai');
  assert(openai?.kind === 'direct' && openai?.primaryEnv === 'OPENAI_API_KEY',
    'direct:openai resolves with OPENAI_API_KEY');
  assert(openai?.forwardUrl === 'https://api.openai.com/v1/chat/completions',
    `direct:openai forward URL wrong: ${openai?.forwardUrl}`);

  const anthropic = providers.getProvider('direct:anthropic');
  assert(anthropic?.primaryEnv === 'ANTHROPIC_API_KEY',
    'direct:anthropic resolves with ANTHROPIC_API_KEY');
  assert(anthropic?.forwardUrl === 'https://api.anthropic.com/v1/chat/completions',
    `direct:anthropic uses OpenAI-compat endpoint, got ${anthropic?.forwardUrl}`);

  const xai = providers.getProvider('direct:xai');
  assert(xai?.primaryEnv === 'XAI_API_KEY', 'direct:xai resolves with XAI_API_KEY');
  assert(xai?.forwardUrl === 'https://api.x.ai/v1/chat/completions',
    `direct:xai forward URL wrong: ${xai?.forwardUrl}`);

  const gemini = providers.getProvider('direct:google-gemini');
  assert(gemini?.primaryEnv === 'GOOGLE_API_KEY',
    'direct:google-gemini resolves with GOOGLE_API_KEY');
  assert(gemini?.forwardUrl.includes('generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
    `direct:google-gemini uses OpenAI-compat shim, got ${gemini?.forwardUrl}`);

  const zai = providers.getProvider('direct:zai');
  assert(zai?.primaryEnv === 'ZAI_API_KEY', 'direct:zai resolves with ZAI_API_KEY');
  assert(zai?.forwardUrl === 'https://api.z.ai/api/paas/v4/chat/completions',
    `direct:zai forward URL wrong: ${zai?.forwardUrl}`);
  const glm52 = providers.DIRECT_PRICING['direct:zai']?.['z-ai/glm-5.2'];
  assert(glm52?.input === 1.12 && glm52?.output === 3.52,
    `z-ai glm-5.2 pricing wrong: ${JSON.stringify(glm52)}`);

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

  // Cloudflare removed 2026-07-29 — most Workers AI models are Paid-plan only.
  assert(providers.getProvider('cloudflare') === undefined,
    'cloudflare should no longer be registered');

  const bedrock = providers.getProvider('bedrock');
  assert(bedrock?.status === 'shipped',
    `bedrock now shipped as OpenAI-compat gateway, got ${bedrock?.status}`);
  assert(bedrock?.primaryEnv === 'AWS_BEARER_TOKEN_BEDROCK',
    `bedrock primary env should be AWS_BEARER_TOKEN_BEDROCK, got ${bedrock?.primaryEnv}`);
  assert(bedrock?.extraEnvs.includes('AWS_REGION'),
    'bedrock requires AWS_REGION as extra env');
  assert(bedrock?.forwardUrlTemplate.includes('bedrock-runtime.{AWS_REGION}.amazonaws.com/openai/v1/chat/completions'),
    `bedrock forward URL should hit OpenAI-compat endpoint, got ${bedrock?.forwardUrlTemplate}`);

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

  // AWS_REGION placeholder — resolves when env is set (Bedrock uses this shape).
  await fs.appendFile(envPath, 'AWS_REGION=us-west-2\n');
  const bedUrl = await providers.resolveUrlTemplate(
    'https://bedrock-runtime.{AWS_REGION}.amazonaws.com/openai/v1/chat/completions');
  assert(bedUrl === 'https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/chat/completions',
    `resolved Bedrock url wrong: ${bedUrl}`);

  // Placeholder can't be filled → null (surface as partial config).
  const bad = await providers.resolveUrlTemplate(
    'https://api.example.com/{NOT_SET_XYZ}/foo');
  assert(bad === null, 'unresolved placeholder returns null');

  // ---------- DIRECT_PRICING shape ----------
  const p = providers.DIRECT_PRICING['direct:moonshot-intl']?.['moonshotai/kimi-k3'];
  assert(p?.input === 2.50 && p?.output === 12.50,
    `moonshot-intl kimi-k3 pricing wrong: ${JSON.stringify(p)}`);
  // Missing (provider, model) pair → undefined → computeCost fail-soft.
  // Groq's slot exists but is empty, so this is a valid "missing" probe.
  const missPrice = providers.DIRECT_PRICING['direct:groq']?.['moonshotai/kimi-k3'];
  assert(missPrice === undefined,
    'missing (provider, model) pair returns undefined — computeCost fail-soft');

  // Fireworks kimi-k3 now has a hand-seeded entry (Fireworks doesn't expose pricing via API).
  const fireworksK3 = providers.DIRECT_PRICING['direct:fireworks']?.['moonshotai/kimi-k3'];
  assert(fireworksK3?.input === 3.00 && fireworksK3?.output === 15.00,
    `Fireworks kimi-k3 pricing wrong: ${JSON.stringify(fireworksK3)}`);

  // Frontier direct-provider pricing seeds (2026-07-31). Verified against
  // provider pricing pages + cross-checked vs OR /api/v1/models — see
  // docs/compat-matrix-31july.md.
  const gpt5 = providers.DIRECT_PRICING['direct:openai']?.['openai/gpt-5'];
  assert(gpt5?.input === 1.25 && gpt5?.output === 10.00,
    `openai gpt-5 pricing wrong: ${JSON.stringify(gpt5)}`);
  const opus5 = providers.DIRECT_PRICING['direct:anthropic']?.['anthropic/claude-opus-5'];
  assert(opus5?.input === 5.00 && opus5?.output === 25.00,
    `anthropic claude-opus-5 pricing wrong: ${JSON.stringify(opus5)}`);
  const sonnet5 = providers.DIRECT_PRICING['direct:anthropic']?.['anthropic/claude-sonnet-5'];
  assert(sonnet5?.input === 2.00 && sonnet5?.output === 10.00,
    `anthropic claude-sonnet-5 intro pricing wrong: ${JSON.stringify(sonnet5)}`);
  const dsFlash = providers.DIRECT_PRICING['direct:deepseek']?.['deepseek/deepseek-v4-flash'];
  assert(dsFlash?.input === 0.14 && dsFlash?.output === 0.28,
    `deepseek v4-flash pricing wrong: ${JSON.stringify(dsFlash)}`);
  const grok45 = providers.DIRECT_PRICING['direct:xai']?.['x-ai/grok-4.5'];
  assert(grok45?.input === 2.00 && grok45?.output === 6.00,
    `x-ai grok-4.5 pricing wrong: ${JSON.stringify(grok45)}`);
  const gemini36 = providers.DIRECT_PRICING['direct:google-gemini']?.['google/gemini-3.6-flash'];
  assert(gemini36?.input === 1.50 && gemini36?.output === 7.50,
    `google gemini-3.6-flash pricing wrong: ${JSON.stringify(gemini36)}`);

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
