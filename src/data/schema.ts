import { z } from 'zod';

export const ORKeySourceSchema = z.enum([
  'env:OPENROUTER_API_KEY',
  '~/.c1/.env',
]);
export type ORKeySource = z.infer<typeof ORKeySourceSchema>;

export const MethodologyStateSchema = z.enum([
  'sdk-env',
  'sdk-config',
  'sdk-hardcoded',
  'no-sdk-detected',
]);
export type MethodologyState = z.infer<typeof MethodologyStateSchema>;

export const MethodologyHardcodedSiteSchema = z.object({
  file: z.string(),
  line: z.number().nullable(),
  literal: z.string(),
  suggestedEnvVar: z.string(),
});
export type MethodologyHardcodedSite = z.infer<typeof MethodologyHardcodedSiteSchema>;

export const MethodologyReportSchema = z.object({
  state: MethodologyStateSchema,
  primarySdk: z.string().nullable(),
  otherSdks: z.array(z.string()),
  evidence: z.string(),
  hardcodedSites: z.array(MethodologyHardcodedSiteSchema).optional(),
  followedFiles: z.array(z.string()),
  scannedAt: z.string(),
  model: z.string(),
});
export type MethodologyReport = z.infer<typeof MethodologyReportSchema>;

export const ConfigSchema = z.object({
  version: z.literal('0.0'),
  targetDir: z.string(),
  runner: z.object({
    cmd: z.string(),
    cwd: z.string().nullable(),
    detectedFrom: z.enum(['package.json', 'pyproject.toml', 'Makefile', 'user']),
  }),
  testGlob: z.object({
    pattern: z.string(),
    expanded: z.string(),
  }),
  tasks: z.object({
    included: z.array(z.string()),
    summaries: z.record(z.string(), z.object({
      summary: z.string(),
      bullets: z.array(z.string()),
      usesLLM: z.boolean().optional(),
      llmEvidence: z.string().optional(),
      mtimeMs: z.number(),
      generatedAt: z.string(),
      model: z.string(),
    })).optional(),
  }),
  methodology: MethodologyReportSchema.optional(),
  orKey: z.object({
    source: ORKeySourceSchema,
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Config = z.infer<typeof ConfigSchema>;

export const RunnerCandidateSchema = z.object({
  cmd: z.string(),
  source: z.string(),
  priority: z.number(),
});
export type RunnerCandidate = z.infer<typeof RunnerCandidateSchema>;

export const ProbedDirSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  fileCount: z.number(),
});
export type ProbedDir = z.infer<typeof ProbedDirSchema>;

export const ScanSchema = z.object({
  // 0.1: added `suggestedGlob` and nested-tests fallback. Bumped from 0.0
  // so pre-existing caches (which used shallow-only probing) get invalidated
  // and auto-rescanned instead of silently returning null for the glob.
  version: z.literal('0.1'),
  scannedAt: z.string(),
  fingerprint: z.object({
    packageJsonMtime: z.number().nullable(),
    pyprojectMtime: z.number().nullable(),
    makefileMtime: z.number().nullable(),
  }),
  runners: z.array(RunnerCandidateSchema),
  probedDirs: z.array(ProbedDirSchema),
  frameworkHints: z.array(z.string()),
  // Persisted so cache-hit re-runs can restore the previously-computed glob
  // (including nested-fallback patterns like `src/**/__tests__/**/*.test.ts`).
  // Optional for backwards-compat with pre-existing caches.
  suggestedGlob: z.string().nullable().optional(),
});
export type Scan = z.infer<typeof ScanSchema>;

export const CatalogModelSchema = z.object({
  slug: z.string(),
  family: z.string(),
  displayName: z.string(),
  inputPrice: z.number(),         // $/M tokens
  outputPrice: z.number(),        // $/M tokens
  context: z.number(),
  totalTokens: z.number(),        // 24h volume from rankings; 0 if unranked
  changePct: z.number(),          // day-over-day % from rankings; 0 if unranked
  rankPosition: z.number().nullable(),   // null if not in top rankings
  isFree: z.boolean(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const OrEndpointSchema = z.object({
  provider: z.string(),           // display name, e.g. "DeepInfra"
  providerTag: z.string(),        // OR routing slug, e.g. "deepinfra/fp4"
  displayName: z.string(),        // "DeepInfra (fp4)"
  quantization: z.string().nullable(),
  contextLength: z.number(),
  inputPrice: z.number(),         // $/M
  outputPrice: z.number(),        // $/M
  isFirstParty: z.boolean(),
  uptimePct30m: z.number().nullable(),
});
export type OrEndpoint = z.infer<typeof OrEndpointSchema>;

export const OrCatalogSchema = z.object({
  version: z.literal('0.2'),
  fetchedAt: z.string(),
  credits: z.number().nullable(),
  models: z.array(CatalogModelSchema),
  endpointsBySlug: z.record(
    z.string(),
    z.object({
      fetchedAt: z.string(),
      endpoints: z.array(OrEndpointSchema),
    }),
  ).optional(),
  errors: z.array(z.string()).optional(),
});
export type OrCatalog = z.infer<typeof OrCatalogSchema>;
