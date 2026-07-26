import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PACKAGE = path.resolve(HERE, '../../../../packages/database');

const TEST_BUCKET = 'invoiceiq-test';
const MINIO_USER = 'invoiceiq';
const MINIO_PASSWORD = 'invoiceiq-dev-secret';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  minio: StartedTestContainer;
  s3Endpoint: string;
}

/**
 * Boots the real application against real Postgres, Redis and MinIO containers.
 *
 * Real datastores rather than mocks, because the things most likely to break
 * here are exactly what a mock cannot reproduce: unique-constraint races,
 * transaction rollback, enum coercion, pgvector operators, presigned-URL
 * signing. The LLM is the only faked dependency, and only because it costs
 * money and is non-deterministic.
 */
export async function createTestContext(): Promise<TestContext> {
  // pgvector image, not plain postgres: the schema declares a vector column, so
  // migrations fail outright without the extension.
  const postgres = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('invoiceiq_test')
    .withUsername('invoiceiq')
    .withPassword('invoiceiq')
    .start();

  const redis = await new RedisContainer('redis:7-alpine').start();

  // Storage is part of the readiness contract, so a fake would let a broken
  // /health/ready pass here and fail in production.
  const minio = await new GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({
      MINIO_ROOT_USER: MINIO_USER,
      MINIO_ROOT_PASSWORD: MINIO_PASSWORD,
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();

  const s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  await createBucket(s3Endpoint);

  const databaseUrl = postgres.getConnectionUri();

  // Migrate with the same command production uses, so a migration that only
  // works via `db push` cannot pass here and fail on deploy.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: DATABASE_PACKAGE,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redis.getConnectionUrl(),
    JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
    ACCESS_TOKEN_TTL: '15m',
    REFRESH_TOKEN_TTL_DAYS: '30',
    S3_ENDPOINT: s3Endpoint,
    S3_BUCKET: TEST_BUCKET,
    S3_ACCESS_KEY_ID: MINIO_USER,
    S3_SECRET_ACCESS_KEY: MINIO_PASSWORD,
    S3_FORCE_PATH_STYLE: 'true',
    CORS_ORIGIN: 'http://localhost:3000',
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  await app.init();

  return { app, prisma: app.get(PrismaService), postgres, redis, minio, s3Endpoint };
}

async function createBucket(endpoint: string): Promise<void> {
  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
  });
  await client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
  client.destroy();
}

export async function destroyTestContext(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await Promise.all([ctx.postgres.stop(), ctx.redis.stop(), ctx.minio.stop()]);
}

/** Clears mutable state between tests without paying to recreate containers. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  // TRUNCATE ... CASCADE in one statement: ordering by foreign key would be
  // fragile every time the schema grows a relation.
  await prisma.client.$executeRawUnsafe(
    'TRUNCATE TABLE "refresh_tokens", "document_events", "validation_findings", ' +
      '"extractions", "review_decisions", "document_chunks", "documents", "users" ' +
      'RESTART IDENTITY CASCADE',
  );
}

/**
 * Clears rate-limiter state between tests.
 *
 * The auth throttle is a real 10-per-minute limit, and a suite that exercises
 * login and refresh repeatedly will legitimately trip it — every test after the
 * tenth request would fail with 429 for reasons unrelated to what it asserts.
 * Resetting per test keeps production limits intact (rather than weakening them
 * for the test environment) while letting each test start from a clean budget.
 * Throttling itself is asserted deliberately in its own test.
 */
export function resetThrottler(app: INestApplication): void {
  const storage = app.get<ThrottlerStorage & { storage?: Map<string, unknown> | object }>(
    ThrottlerStorage,
    { strict: false },
  );

  const internal = storage.storage;
  if (internal instanceof Map) {
    internal.clear();
  } else if (internal && typeof internal === 'object') {
    for (const key of Object.keys(internal)) {
      delete (internal as Record<string, unknown>)[key];
    }
  }
}
