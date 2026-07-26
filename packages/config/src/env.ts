import { z } from 'zod';

/**
 * 12-factor configuration. Every process validates its slice of the environment
 * once, at boot, and crashes immediately if anything is missing or malformed —
 * never at 3am on the first request that happens to read a bad value.
 *
 * The schema is split so the API does not have to carry LLM credentials and the
 * worker does not have to carry JWT secrets: each process declares exactly what
 * it needs, which keeps the deploy surface honest.
 */

const NodeEnv = z.enum(['development', 'test', 'production']);

/** Shared by every process. */
export const BaseEnvSchema = z.object({
  NODE_ENV: NodeEnv.default('development'),
  // 'silent' is a real pino level and the right one for test runs — otherwise
  // every integration suite drowns its own assertions in request logs.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1).default('eu-south-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  /** MinIO needs path-style addressing; real S3 does not. */
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),

  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
});

/** API-only configuration. */
export const ApiEnvSchema = BaseEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(3001),
  /** 256-bit secret, hex or base64. Rejected below 32 chars so a weak dev value cannot ship. */
  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** Exact origin(s) — never a wildcard, since we send credentialed cookies. */
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim())),
  PRESIGNED_GET_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  PRESIGNED_PUT_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /** Pre-filled on the login screen so the demo takes 90 seconds, not five minutes. */
  DEMO_EMAIL: z.email().optional(),
  DEMO_PASSWORD: z.string().optional(),
});

/** Worker-only configuration. */
export const WorkerEnvSchema = BaseEnvSchema.extend({
  /**
   * `fixture` replays recorded responses from packages/ai/src/fixtures — the default,
   * so the whole pipeline runs with zero network and zero spend. Flip to `anthropic`
   * once ANTHROPIC_API_KEY is set.
   */
  LLM_PROVIDER: z.enum(['anthropic', 'fixture']).default('fixture'),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  /** Escalation tier — used only when the default model fails schema twice (M11). */
  LLM_MODEL_FALLBACK: z.string().default('claude-sonnet-5'),
  MAX_EXTRACTION_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  MAX_PROMPT_TOKENS: z.coerce.number().int().positive().default(8000),

  /**
   * `local` runs multilingual MiniLM in-process (no key, 384 dims, handles the
   * Italian sample invoices). `deterministic` is the hash-based test embedder.
   * EMBEDDING_DIM must match the pgvector column — asserted at boot by the adapter.
   */
  EMBEDDING_PROVIDER: z.enum(['local', 'openai', 'deterministic']).default('local'),
  EMBEDDING_MODEL: z.string().default('Xenova/paraphrase-multilingual-MiniLM-L12-v2'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),
  OPENAI_API_KEY: z.string().optional(),

  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  EXTRACTION_CONCURRENCY: z.coerce.number().int().positive().default(2),
  EMBEDDING_CONCURRENCY: z.coerce.number().int().positive().default(5),
  /** Blunt guard against runaway spend, independent of provider rate limits. */
  EXTRACTION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
})
  .refine((env) => env.LLM_PROVIDER !== 'anthropic' || Boolean(env.ANTHROPIC_API_KEY), {
    message: 'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic',
    path: ['ANTHROPIC_API_KEY'],
  })
  .refine((env) => env.EMBEDDING_PROVIDER !== 'openai' || Boolean(env.OPENAI_API_KEY), {
    message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai',
    path: ['OPENAI_API_KEY'],
  });

export type BaseEnv = z.infer<typeof BaseEnvSchema>;
export type ApiEnv = z.infer<typeof ApiEnvSchema>;
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

/**
 * Parse and freeze. Throws a readable, aggregated error listing every bad
 * variable at once rather than failing on the first one.
 */
export function loadEnv<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return Object.freeze(result.data) as z.infer<T>;
}

export const loadApiEnv = (source: NodeJS.ProcessEnv = process.env): ApiEnv =>
  loadEnv(ApiEnvSchema, source);

export const loadWorkerEnv = (source: NodeJS.ProcessEnv = process.env): WorkerEnv =>
  loadEnv(WorkerEnvSchema, source);
