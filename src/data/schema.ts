import { z } from 'zod';

export const ORKeySourceSchema = z.enum([
  'env:OPENROUTER_API_KEY',
  '~/.c1/.env',
]);
export type ORKeySource = z.infer<typeof ORKeySourceSchema>;

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
  version: z.literal('0.0'),
  scannedAt: z.string(),
  fingerprint: z.object({
    packageJsonMtime: z.number().nullable(),
    pyprojectMtime: z.number().nullable(),
    makefileMtime: z.number().nullable(),
  }),
  runners: z.array(RunnerCandidateSchema),
  probedDirs: z.array(ProbedDirSchema),
  frameworkHints: z.array(z.string()),
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
