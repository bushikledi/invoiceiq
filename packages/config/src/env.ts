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

  /**
   * Embedding configuration lives in the SHARED base schema, not in the worker
   * slice, because both processes need it and they must agree. The worker
   * embeds documents; the API embeds the search query. If they use different
   * models the query vector lands in a different space and every result is
   * noise — with no error anywhere. Sharing the definition makes the agreement
   * structural instead of a convention someone has to remember.
   *
   * `local` runs multilingual MiniLM in-process (no key, 384 dims, handles the
   * Italian sample invoices). `deterministic` is the hash-based test embedder.
   * EMBEDDING_DIM must match the pgvector column, which is asserted at boot.
   */
  EMBEDDING_PROVIDER: z.enum(['local', 'openai', 'deterministic']).default('local'),
  EMBEDDING_MODEL: z.string().default('Xenova/paraphrase-multilingual-MiniLM-L12-v2'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),
  OPENAI_API_KEY: z.string().optional(),

  /**
   * How long a document may sit in PROCESSING before it counts as stranded.
   *
   * Shared for the same reason the embedding settings are: the worker's janitor
   * and the API's requeue endpoint both apply this threshold, and if they
   * disagreed an operator could requeue a document one second before the
   * janitor decided it was still healthy — two writers, two enqueues, one
   * document processed twice.
   *
   * Set it comfortably above the slowest legitimate extraction. Below the real
   * p99 the janitor reclaims documents that were merely slow, which means
   * paying twice, most often for exactly the large multi-page invoices that are
   * slowest to begin with.
   */
  STRANDED_AFTER_MINUTES: z.coerce.number().int().positive().default(15),
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

  /**
   * Bearer token required to scrape `/metrics`. Unset means the endpoint does
   * not exist — 404, not 401.
   *
   * Off by default because the alternative is worse. The API is the one process
   * with a public origin, and a metrics endpoint that ships open publishes
   * request volumes, error rates, spend and route names to anyone who guesses
   * the path. Defaulting to absent means exposing it is a decision somebody
   * made, and 404 rather than 401 means an unconfigured deployment does not
   * even confirm the endpoint is there.
   */
  METRICS_TOKEN: z.string().min(16).optional(),

  /**
   * Per-IP request ceilings.
   *
   * Configurable rather than hard-coded because the right number depends
   * entirely on the deployment. Behind a shared NAT or a corporate proxy every
   * user of a customer arrives as one IP, and a limit tuned for individuals
   * throttles the whole office; a single-tenant install can be far stricter
   * than a public one.
   *
   * The auth bucket is deliberately far tighter: login and refresh are the
   * routes worth brute-forcing, and nobody legitimately signs in ten times a
   * minute.
   */
  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
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
  /** Escalation tier — reached only after the default model fails the schema. */
  LLM_MODEL_FALLBACK: z.string().default('claude-sonnet-5'),
  /**
   * Attempts spent on a tier before escalating. With the default 3 attempts
   * that means two tries on the cheap model and one on the strong one, which is
   * the shape that pays the premium only where it has evidence it is needed.
   */
  LLM_TIER_ATTEMPTS: z.coerce.number().int().positive().default(2),
  MAX_EXTRACTION_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  MAX_PROMPT_TOKENS: z.coerce.number().int().positive().default(8000),

  /**
   * Daily ceiling on LLM spend, in USD. Defaults to a real number rather than
   * to `0`, because a cap that ships disabled is a cap nobody has — and with the
   * fixture provider costing nothing it never trips in development anyway.
   */
  LLM_DAILY_SPEND_CAP_USD: z.coerce.number().min(0).default(5),
  /**
   * Reuse a previous extraction of byte-identical content under the same prompt
   * and model. Only the model output is reused; validation and scoring always
   * re-run. Switchable so a nightly contract run can force real calls.
   */
  EXTRACTION_CACHE_ENABLED: z.stringbool().default(true),

  /**
   * Prometheus scrape port for the otherwise headless worker. 9464 is the
   * OpenTelemetry Prometheus exporter convention. Bind it to a private network:
   * it exposes spend and queue depth, which are nobody else's business. 0
   * disables the server entirely.
   */
  WORKER_METRICS_PORT: z.coerce.number().int().min(0).default(9464),

  JANITOR_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),

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
