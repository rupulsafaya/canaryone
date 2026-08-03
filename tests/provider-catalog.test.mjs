// Unit test for src/scan/provider-catalog.ts — fetch, canonicalize, cache,
// stale detection. Mocks global.fetch for the catalog HTTP call and injects
// a stub callHaiku so no network happens.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

async function main() {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'c1-provcat-test-'));
  process.env.HOME = tmpHome;
  await fs.mkdir(path.join(tmpHome, '.c1'), { recursive: true });
  const cachePath = path.join(tmpHome, '.c1', 'provider-catalogs.json');

  const canaryoneDir = new URL('..', import.meta.url).pathname;
  const cat = await import(
    pathToFileURL(path.join(canaryoneDir, 'src/scan/provider-catalog.ts')).href
  );

  // ---------- extractSlugs — every response shape ----------
  const openaiShape = { data: [{ id: 'openai/gpt-5' }, { id: 'openai/gpt-4o' }] };
  assert(
    JSON.stringify(cat.extractSlugs(openaiShape)) === JSON.stringify(['openai/gpt-5', 'openai/gpt-4o']),
    'OpenAI-compat data[].id shape',
  );

  const cfShape = { result: { data: [{ id: '@cf/moonshotai/kimi-k3' }] }, success: true };
  assert(
    JSON.stringify(cat.extractSlugs(cfShape)) === JSON.stringify(['@cf/moonshotai/kimi-k3']),
    'CF wrapped result.data shape',
  );

  const cfFlatShape = { result: [{ id: '@cf/meta/llama-4' }], success: true };
  assert(
    JSON.stringify(cat.extractSlugs(cfFlatShape)) === JSON.stringify(['@cf/meta/llama-4']),
    'CF flat result[] shape',
  );

  const nameOnly = { data: [{ name: 'kimi-k3-preview' }] };
  assert(
    JSON.stringify(cat.extractSlugs(nameOnly)) === JSON.stringify(['kimi-k3-preview']),
    'fallback to name field',
  );

  // Together AI: top-level array (no `data` wrapper).
  const togetherShape = [
    { id: 'Qwen/Qwen3.5-9B', object: 'model' },
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', object: 'model' },
  ];
  assert(
    JSON.stringify(cat.extractSlugs(togetherShape)) ===
      JSON.stringify(['Qwen/Qwen3.5-9B', 'meta-llama/Llama-3.3-70B-Instruct-Turbo']),
    'Together AI top-level-array shape',
  );

  assert(cat.extractSlugs({}).length === 0, 'empty response → empty list');
  assert(cat.extractSlugs(null).length === 0, 'null → empty list');
  assert(cat.extractSlugs({ data: 'not-an-array' }).length === 0, 'non-array data → empty');

  // ---------- parseCanonicalContent — strips fences, extracts JSON ----------
  const p1 = cat.parseCanonicalContent('{"a":"x/a","b":"y/b"}');
  assert(p1.a === 'x/a' && p1.b === 'y/b', 'plain JSON parses');

  const p2 = cat.parseCanonicalContent('```json\n{"a":"x/a"}\n```');
  assert(p2.a === 'x/a', 'fenced JSON parses');

  const p3 = cat.parseCanonicalContent('here you go: {"a":"x/a"} — that\'s it');
  assert(p3.a === 'x/a', 'prose-wrapped JSON parses');

  const p4 = cat.parseCanonicalContent('{"a":"x/a","b":null,"c":42}');
  assert(p4.a === 'x/a' && !('b' in p4) && !('c' in p4),
    'non-string values dropped');

  // ---------- canonicalizeSlugs — identity fast-path for OR/Vercel/CF ----------
  const orCanon = await cat.canonicalizeSlugs(
    'openrouter',
    ['openai/gpt-5', 'moonshotai/kimi-k3'],
    { orKey: 'unused' },
  );
  assert(orCanon.map['openai/gpt-5'] === 'openai/gpt-5'
      && orCanon.map['moonshotai/kimi-k3'] === 'moonshotai/kimi-k3',
    'OR identity map');

  const vercelCanon = await cat.canonicalizeSlugs(
    'vercel',
    ['anthropic/claude-opus-5'],
    { orKey: 'unused' },
  );
  assert(vercelCanon.map['anthropic/claude-opus-5'] === 'anthropic/claude-opus-5',
    'Vercel identity map');

  // ---------- canonicalizeSlugs — direct with mocked Haiku ----------
  const stubHaiku = async (rawSlugs, orKey, orCanonicalSlugs) => {
    assert(orKey === 'sk-or-test', `mocked haiku got wrong orKey: ${orKey}`);
    assert(Array.isArray(orCanonicalSlugs), `mocked haiku got non-array orCanonicalSlugs: ${orCanonicalSlugs}`);
    const map = {};
    for (const s of rawSlugs) {
      if (s.includes('kimi')) map[s] = 'moonshotai/kimi-k3';
      else if (s.includes('moonshot-v1')) map[s] = 'moonshotai/moonshot-v1-32k';
      else map[s] = s;
    }
    return map;
  };
  const direct = await cat.canonicalizeSlugs(
    'direct:moonshot-intl',
    ['kimi-k3-preview', 'moonshot-v1-32k', 'random-thing'],
    { orKey: 'sk-or-test', callHaiku: stubHaiku },
  );
  assert(direct.map['kimi-k3-preview'] === 'moonshotai/kimi-k3', 'kimi normalized');
  assert(direct.map['moonshot-v1-32k'] === 'moonshotai/moonshot-v1-32k', 'moonshot-v1 normalized');
  assert(direct.map['random-thing'] === 'random-thing', 'unknown preserved verbatim');

  // ---------- canonicalizeSlugs — Haiku error → identity fallback + error ----------
  const throwHaiku = async () => { throw new Error('haiku boom'); };
  const fallback = await cat.canonicalizeSlugs(
    'direct:nebius',
    ['some-model'],
    { orKey: 'sk-or-test', callHaiku: throwHaiku },
  );
  assert(fallback.map['some-model'] === 'some-model',
    'Haiku error → identity fallback');
  assert(fallback.error && fallback.error.includes('haiku boom'),
    'Haiku error surfaced');

  // ---------- canonicalizeSlugs — missing orKey → identity + warning ----------
  const noKey = await cat.canonicalizeSlugs(
    'direct:groq',
    ['llama-3.1-8b'],
    { orKey: null },
  );
  assert(noKey.map['llama-3.1-8b'] === 'llama-3.1-8b',
    'no orKey → identity fallback');
  assert(noKey.error && noKey.error.includes('no OR key'),
    'no-key error surfaced');

  // ---------- loadCatalogs / writeCatalogs round-trip ----------
  const empty = await cat.loadCatalogs(cachePath);
  assert(Object.keys(empty).length === 0, 'missing file → empty object');

  const stub = {
    openrouter: {
      fetched_at: new Date().toISOString(),
      models_raw: ['openai/gpt-4o'],
      canonical_map: { 'openai/gpt-4o': 'openai/gpt-4o' },
    },
  };
  await cat.writeCatalogs(stub, cachePath);
  const read = await cat.loadCatalogs(cachePath);
  assert(read.openrouter?.models_raw[0] === 'openai/gpt-4o',
    'writeCatalogs / loadCatalogs round-trip');

  // Mode 0o600.
  const st = await fs.stat(cachePath);
  assert((st.mode & 0o777) === 0o600, `expected mode 0o600, got ${(st.mode & 0o777).toString(8)}`);

  // Corrupted file → treated as empty (no throw).
  await fs.writeFile(cachePath, 'not json{{{');
  const corrupt = await cat.loadCatalogs(cachePath);
  assert(Object.keys(corrupt).length === 0, 'corrupt cache → empty (not throw)');

  // ---------- isStale ----------
  const fresh = { fetched_at: new Date().toISOString(), models_raw: [], canonical_map: {} };
  const old = { fetched_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), models_raw: [], canonical_map: {} };
  assert(cat.isStale(fresh) === false, 'fresh entry not stale');
  assert(cat.isStale(old) === true, '30h-old entry is stale (default 24h TTL)');
  const slightlyOld = { fetched_at: new Date(Date.now() - 5000).toISOString(), models_raw: [], canonical_map: {} };
  assert(cat.isStale(slightlyOld, 1000) === true, '5s-old entry with 1s ttl → stale');
  assert(cat.isStale({ fetched_at: 'garbage', models_raw: [], canonical_map: {} }) === true,
    'garbage timestamp → stale');

  // ---------- refreshCatalog — end-to-end with mocked fetch + Haiku ----------
  await fs.rm(cachePath, { force: true });

  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, headers: init?.headers ?? {} });
    // Mimic a Moonshot /v1/models response.
    return new Response(JSON.stringify({
      data: [
        { id: 'kimi-k3-preview' },
        { id: 'moonshot-v1-32k' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await cat.refreshCatalog(
      'direct:moonshot-intl',
      'msk-mock',
      {
        orKey: 'sk-or-test',
        callHaiku: stubHaiku,
        cachePath,
        now: () => new Date('2026-07-29T10:22:52Z'),
      },
    );
    assert(fetchCalls.length === 1, `expected 1 fetch, got ${fetchCalls.length}`);
    const call = fetchCalls[0];
    assert(String(call.url).includes('api.moonshot.ai/v1/models'),
      `wrong catalog URL: ${call.url}`);
    assert(call.headers.Authorization === 'Bearer msk-mock',
      `expected Bearer msk-mock, got ${call.headers.Authorization}`);

    assert(result.entry.models_raw.length === 2, 'moonshot catalog should have 2 slugs');
    assert(result.entry.canonical_map['kimi-k3-preview'] === 'moonshotai/kimi-k3',
      'canonical map should reflect Haiku output');
    assert(result.entry.errors === undefined, 'no errors on success');
    assert(result.changed === true, 'first fetch counts as changed');

    // Persisted to disk.
    const persisted = await cat.loadCatalogs(cachePath);
    assert(persisted['direct:moonshot-intl']?.models_raw.length === 2,
      'catalog persisted');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ---------- refreshCatalog — fetch fails → preserves prior entry + records error ----------
  const priorCatalog = await cat.loadCatalogs(cachePath);
  assert(priorCatalog['direct:moonshot-intl'].models_raw.length === 2,
    'prior entry present before failure');

  globalThis.fetch = async () => new Response('server error', { status: 503 });
  try {
    const failResult = await cat.refreshCatalog(
      'direct:moonshot-intl',
      'msk-mock',
      { orKey: 'sk-or-test', callHaiku: stubHaiku, cachePath },
    );
    assert(failResult.entry.errors && failResult.entry.errors.length > 0,
      'errors[] populated on fetch failure');
    assert(failResult.entry.errors[0].includes('503'), 'error mentions HTTP status');
    // Prior slugs preserved.
    assert(failResult.entry.models_raw.length === 2,
      'prior slugs preserved when refresh fails');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ---------- refreshCatalog — router with public catalog (Vercel, no auth) ----------
  await fs.rm(cachePath, { force: true });
  const publicFetchCalls = [];
  globalThis.fetch = async (url, init) => {
    publicFetchCalls.push({ url, headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      data: [{ id: 'openai/gpt-5' }, { id: 'anthropic/claude-opus-5' }],
    }), { status: 200 });
  };
  try {
    const vercelResult = await cat.refreshCatalog(
      'vercel',
      null,  // no token — endpoint is public
      { orKey: 'sk-or-test', callHaiku: stubHaiku, cachePath },
    );
    assert(vercelResult.entry.models_raw.length === 2,
      'vercel catalog fetched without auth');
    // Auth header should NOT have been set for the public endpoint.
    assert(!publicFetchCalls[0].headers.Authorization,
      'no Authorization header for public catalog');
    // Vercel is in IDENTITY_MAP_PROVIDERS → no Haiku call happened.
    // (We can't observe that directly, but canonical_map should be identity.)
    assert(vercelResult.entry.canonical_map['openai/gpt-5'] === 'openai/gpt-5',
      'vercel canonical map is identity');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ---------- refreshCatalog — Bedrock requires AWS_REGION placeholder ----------
  // (Same URL-template semantics that CF used pre-2026-07-29; Bedrock's OpenAI-
  // compat gateway inherited the {ENV_VAR} substitution path.)
  await fs.rm(cachePath, { force: true });
  delete process.env.AWS_REGION;
  const bedNoRegion = await cat.refreshCatalog(
    'bedrock',
    'aws-tok',
    { orKey: 'sk-or-test', callHaiku: stubHaiku, cachePath },
  );
  assert(bedNoRegion.entry.errors && bedNoRegion.entry.errors[0].includes('missing env var'),
    'Bedrock without AWS_REGION → clear error');

  // With AWS_REGION set, catalog URL resolves and modelSummaries shape parses.
  process.env.AWS_REGION = 'us-west-2';
  const bedCalls = [];
  globalThis.fetch = async (url, init) => {
    bedCalls.push({ url, headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      modelSummaries: [
        { modelId: 'openai.gpt-oss-120b-1:0', modelName: 'gpt-oss 120b' },
        { modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0', modelName: 'Claude 3.5 Sonnet' },
      ],
    }), { status: 200 });
  };
  try {
    const bedOk = await cat.refreshCatalog(
      'bedrock',
      'aws-tok',
      { orKey: 'sk-or-test', callHaiku: stubHaiku, cachePath },
    );
    assert(String(bedCalls[0].url).includes('bedrock.us-west-2.amazonaws.com/foundation-models'),
      `Bedrock URL should include region + control-plane host, got ${bedCalls[0].url}`);
    assert(bedCalls[0].headers.Authorization === 'Bearer aws-tok',
      'Bedrock catalog uses Bearer auth');
    assert(bedOk.entry.models_raw.length === 2,
      `Bedrock modelSummaries shape should yield 2 slugs, got ${bedOk.entry.models_raw.length}`);
    assert(bedOk.entry.models_raw.includes('openai.gpt-oss-120b-1:0'),
      'Bedrock catalog should include gpt-oss slug');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AWS_REGION;
  }

  await fs.rm(tmpHome, { recursive: true, force: true });
  console.log('provider-catalog.test.mjs — all assertions passed');
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
