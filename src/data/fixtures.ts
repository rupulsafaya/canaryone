// Iter2-shape mock data. Numbers seeded from canaryone-cloud/GLM-5.2 5-provider batch (r5 judged).
// One-time snapshot; refresh path TBD.

export type Task = {
  id: string;
  file: string;
  name: string;
  summary: string;
  confidence: number;
  verifyCmd: string;
  included: boolean;
};

export type Model = {
  slug: string;
  family: string;
  displayName: string;
  inputPrice: number;   // $/M
  outputPrice: number;  // $/M
  context: number;      // tokens
  totalTokens: number;  // last-24h volume from OR rankings
  changePct: number;    // day-over-day % change
  rankPosition: number | null;
  isFree: boolean;
};

export type CellState = 'queued' | 'running' | 'passed' | 'failed' | 'error';
export type Cell = { state: CellState; costUsd: number; latencyMs: number };

export const TASKS: Task[] = [
  { id: 't01', file: 'tests/agent/auth.spec.ts',      name: 'fix expired-token refresh flow',              summary: 'Agent must patch middleware to renew JWT on 401 before retry.', confidence: 0.92, verifyCmd: 'pnpm test tests/agent/auth.spec.ts',      included: true },
  { id: 't02', file: 'tests/agent/checkout.spec.ts',  name: 'add idempotency key to charge',               summary: 'Refactor checkout handler; add I-key generation + Stripe replay.', confidence: 0.89, verifyCmd: 'pnpm test tests/agent/checkout.spec.ts', included: true },
  { id: 't03', file: 'tests/agent/rate-limit.spec.ts', name: 'implement token-bucket rate limit',           summary: 'Multi-turn: draft, run tests, fix off-by-one on window slide.',      confidence: 0.94, verifyCmd: 'pnpm test tests/agent/rate-limit.spec.ts', included: true },
  { id: 't04', file: 'tests/agent/search.spec.ts',    name: 'fix fuzzy-match false negatives',             summary: 'Diagnose ranking regression; tweak trigram threshold.',              confidence: 0.78, verifyCmd: 'pnpm test tests/agent/search.spec.ts',   included: true },
  { id: 't05', file: 'tests/agent/pdf-parser.spec.ts', name: 'handle malformed PDF gracefully',            summary: 'Add null-safe fallback path; log corrupt-metadata cases.',           confidence: 0.86, verifyCmd: 'pnpm test tests/agent/pdf-parser.spec.ts', included: true },
  { id: 't06', file: 'tests/agent/queue.spec.ts',     name: 'drain dead-letter on startup',                summary: 'Reprocess DLQ items; multi-tool: read config, spawn worker, verify.', confidence: 0.91, verifyCmd: 'pnpm test tests/agent/queue.spec.ts',    included: true },
  { id: 't07', file: 'tests/agent/webhook.spec.ts',   name: 'verify webhook HMAC signatures',              summary: 'Bug-fix; classic tool_call pattern.',                                 confidence: 0.83, verifyCmd: 'pnpm test tests/agent/webhook.spec.ts',  included: true },
  { id: 't08', file: 'tests/agent/migrate.spec.ts',   name: 'write migration 004_users_soft_delete',       summary: 'Author + apply migration; verify FK constraints.',                    confidence: 0.87, verifyCmd: 'pnpm test tests/agent/migrate.spec.ts',  included: false },
  { id: 't09', file: 'tests/agent/graph.spec.ts',     name: 'fix cycle in dependency resolver',            summary: 'Diagnose Kahn traversal bug; add cycle-detection.',                   confidence: 0.79, verifyCmd: 'pnpm test tests/agent/graph.spec.ts',    included: false },
  { id: 't10', file: 'tests/agent/i18n.spec.ts',      name: 'add fallback locale chain',                   summary: 'Refactor locale lookup; add es-MX → es → en cascade.',                confidence: 0.72, verifyCmd: 'pnpm test tests/agent/i18n.spec.ts',     included: false },
  { id: 't11', file: 'tests/agent/observability.spec.ts', name: 'wire OTLP tracing to worker pool',       summary: 'Multi-step; span propagation across async boundary.',                 confidence: 0.90, verifyCmd: 'pnpm test tests/agent/observability.spec.ts', included: false },
  { id: 't12', file: 'tests/agent/schema.spec.ts',    name: 'generate zod schema from openapi',            summary: 'Codegen; verify round-trip via example fixtures.',                    confidence: 0.85, verifyCmd: 'pnpm test tests/agent/schema.spec.ts',   included: false },
];

// Top 20 by count, from OR /api/frontend/v1/rankings/models?view=day&models=all snapshot
export const TOP_MODELS: Model[] = [
  { slug: 'xiaomi/mimo-v2.5',              family: 'other',    displayName: 'MiMo-V2.5',            inputPrice: 0.15, outputPrice: 0.60, context: 128_000, totalTokens: 1_520_000_000_000, changePct:  5, rankPosition:  1, isFree: false },
  { slug: 'deepseek/deepseek-v4-flash',    family: 'deepseek', displayName: 'DeepSeek V4 Flash',    inputPrice: 0.20, outputPrice: 0.80, context: 128_000, totalTokens: 1_030_000_000_000, changePct:  9, rankPosition:  2, isFree: false },
  { slug: 'tencent/hy3',                   family: 'other',    displayName: 'Hy3',                  inputPrice: 0.30, outputPrice: 1.20, context: 128_000, totalTokens:   597_000_000_000, changePct:  1, rankPosition:  3, isFree: false },
  { slug: 'deepseek/deepseek-v4-pro',      family: 'deepseek', displayName: 'DeepSeek V4 Pro',      inputPrice: 0.40, outputPrice: 1.60, context: 128_000, totalTokens:   493_000_000_000, changePct: 19, rankPosition:  4, isFree: false },
  { slug: 'nvidia/nemotron-3-ultra',       family: 'other',    displayName: 'Nemotron 3 Ultra',     inputPrice: 0.00, outputPrice: 0.00, context: 128_000, totalTokens:   405_000_000_000, changePct: -4, rankPosition:  5, isFree: true },
  { slug: 'z-ai/glm-5.2',                  family: 'z-ai',     displayName: 'GLM 5.2',              inputPrice: 0.14, outputPrice: 0.44, context: 128_000, totalTokens:   332_000_000_000, changePct:  5, rankPosition:  6, isFree: false },
  { slug: 'minimax/minimax-m3',            family: 'other',    displayName: 'MiniMax M3',           inputPrice: 0.25, outputPrice: 1.00, context: 200_000, totalTokens:   257_000_000_000, changePct: -2, rankPosition:  7, isFree: false },
  { slug: 'stepfun/step-3.7-flash',        family: 'other',    displayName: 'Step 3.7 Flash',       inputPrice: 0.18, outputPrice: 0.72, context: 128_000, totalTokens:   193_000_000_000, changePct: -6, rankPosition:  8, isFree: false },
  { slug: 'moonshotai/kimi-k3',            family: 'other',    displayName: 'Kimi K3',              inputPrice: 0.30, outputPrice: 1.10, context: 200_000, totalTokens:   165_000_000_000, changePct:  5, rankPosition:  9, isFree: false },
  { slug: 'inclusionai/ling-3-flash',      family: 'other',    displayName: 'Ling-3 Flash',         inputPrice: 0.00, outputPrice: 0.00, context: 128_000, totalTokens:   151_000_000_000, changePct: 18, rankPosition: 10, isFree: true },
  { slug: 'anthropic/claude-haiku-4.5',    family: 'anthropic',displayName: 'Claude Haiku 4.5',     inputPrice: 1.00, outputPrice: 5.00, context: 200_000, totalTokens:   142_000_000_000, changePct:  3, rankPosition: 11, isFree: false },
  { slug: 'openai/gpt-5-mini',             family: 'openai',   displayName: 'GPT-5 Mini',           inputPrice: 0.30, outputPrice: 2.40, context: 400_000, totalTokens:   129_000_000_000, changePct:  8, rankPosition: 12, isFree: false },
  { slug: 'anthropic/claude-sonnet-4.6',   family: 'anthropic',displayName: 'Claude Sonnet 4.6',    inputPrice: 3.00, outputPrice: 15.0, context: 200_000, totalTokens:    98_000_000_000, changePct:  2, rankPosition: 13, isFree: false },
  { slug: 'google/gemini-3-flash',         family: 'google',   displayName: 'Gemini 3 Flash',       inputPrice: 0.30, outputPrice: 2.50, context: 1_000_000, totalTokens:  87_000_000_000, changePct: 11, rankPosition: 14, isFree: false },
  { slug: 'qwen/qwen-3-coder',             family: 'qwen',     displayName: 'Qwen 3 Coder',         inputPrice: 0.35, outputPrice: 1.40, context: 128_000, totalTokens:    76_000_000_000, changePct:  4, rankPosition: 15, isFree: false },
  { slug: 'x-ai/grok-4',                   family: 'xai',      displayName: 'Grok 4',               inputPrice: 5.00, outputPrice: 15.0, context: 256_000, totalTokens:    68_000_000_000, changePct: -3, rankPosition: 16, isFree: false },
  { slug: 'openai/gpt-5',                  family: 'openai',   displayName: 'GPT-5',                inputPrice: 3.50, outputPrice: 14.0, context: 400_000, totalTokens:    61_000_000_000, changePct:  6, rankPosition: 17, isFree: false },
  { slug: 'anthropic/claude-opus-4.7',     family: 'anthropic',displayName: 'Claude Opus 4.7',      inputPrice: 15.0, outputPrice: 75.0, context: 1_000_000, totalTokens:  54_000_000_000, changePct:  1, rankPosition: 18, isFree: false },
  { slug: 'mistralai/mistral-large-2',     family: 'mistral',  displayName: 'Mistral Large 2',      inputPrice: 2.00, outputPrice: 6.00, context: 128_000, totalTokens:    48_000_000_000, changePct: -1, rankPosition: 19, isFree: false },
  { slug: 'meta-llama/llama-4-scout',      family: 'meta',     displayName: 'Llama 4 Scout',        inputPrice: 0.28, outputPrice: 0.85, context: 512_000, totalTokens:    41_000_000_000, changePct:  0, rankPosition: 20, isFree: false },
];

export const OTHER_MODELS: Model[] = [
  { slug: '01-ai/yi-large',                family: 'other',    displayName: 'Yi Large',             inputPrice: 0.30, outputPrice: 0.90, context: 128_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'ai21/jamba-large-1.7',          family: 'other',    displayName: 'Jamba Large 1.7',      inputPrice: 0.50, outputPrice: 0.70, context: 256_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'amazon/nova-micro-v1',          family: 'other',    displayName: 'Nova Micro v1',        inputPrice: 0.04, outputPrice: 0.14, context: 128_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'baichuan/baichuan-3.5-pro',     family: 'other',    displayName: 'Baichuan 3.5 Pro',     inputPrice: 0.60, outputPrice: 1.80, context: 128_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'cohere/command-r-plus-2',       family: 'cohere',   displayName: 'Command R+ 2',         inputPrice: 2.50, outputPrice: 10.0, context: 128_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'cognitivecomputations/dolphin-72b', family: 'other',displayName: 'Dolphin 72B',         inputPrice: 0.00, outputPrice: 0.00, context:  32_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: true },
  { slug: 'deepseek/deepseek-r2',          family: 'deepseek', displayName: 'DeepSeek R2',          inputPrice: 0.55, outputPrice: 2.20, context: 128_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'inflection/pi-3.5',             family: 'other',    displayName: 'Pi 3.5',               inputPrice: 0.30, outputPrice: 1.20, context:  32_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'liquid/lfm-40b',                family: 'other',    displayName: 'Liquid LFM 40B',       inputPrice: 0.15, outputPrice: 0.60, context:  32_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'meta-llama/llama-4-maverick',   family: 'meta',     displayName: 'Llama 4 Maverick',     inputPrice: 0.90, outputPrice: 2.80, context: 512_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'mistralai/codestral-2',         family: 'mistral',  displayName: 'Codestral 2',          inputPrice: 0.30, outputPrice: 0.90, context:  32_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'nousresearch/hermes-4-70b',     family: 'other',    displayName: 'Hermes 4 70B',         inputPrice: 0.40, outputPrice: 0.40, context: 128_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'perplexity/sonar-large',        family: 'other',    displayName: 'Sonar Large',          inputPrice: 1.00, outputPrice: 1.00, context: 128_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
  { slug: 'qwen/qwq-32b',                  family: 'qwen',     displayName: 'QwQ 32B',              inputPrice: 0.00, outputPrice: 0.00, context:  32_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: true },
  { slug: 'reka/reka-flash-3',             family: 'other',    displayName: 'Reka Flash 3',         inputPrice: 0.80, outputPrice: 2.00, context: 128_000, totalTokens: 0, changePct: 0, rankPosition: null, isFree: false },
];

export const ALL_MODELS: Model[] = [...TOP_MODELS, ...OTHER_MODELS];

// Persist across screens
export type SelectedModelKey = string; // slug

// Baseline tokens per task (seeded from iter2)
export const BASELINE_INPUT_TOKENS = 4800;
export const BASELINE_OUTPUT_TOKENS = 1200;
export const JUDGE_COST_PER_TASK = 0.005;
export const P50_RUN_SECONDS = 90;

export const OR_CREDITS_REMAINING = 12.4;

export const ENV_HAS_OR_KEY = true; // toggle to false to preview the prompt path
