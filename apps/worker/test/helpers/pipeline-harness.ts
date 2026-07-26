import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { Queue } from 'bullmq';
import { FIXTURES, FixtureLlmExtractor } from '@invoiceiq/ai';
import { createPrismaClient, type PrismaClient } from '@invoiceiq/database';
import { WorkerAppModule } from '../../src/app.module.js';
import { LLM_EXTRACTOR } from '../../src/ai/llm.module.js';
import { QUEUE_EXTRACTION, JOB_EXTRACT_DOCUMENT } from '../../src/queues.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PACKAGE = path.resolve(HERE, '../../../../packages/database');
const SAMPLES = path.resolve(HERE, '../../../../packages/ai/samples');

const BUCKET = 'invoiceiq-test';
const MINIO_USER = 'invoiceiq';
const MINIO_PASSWORD = 'invoiceiq-dev-secret';

export interface PipelineHarness {
  app: INestApplicationContext;
  prisma: PrismaClient;
  queue: Queue;
  llm: FixtureLlmExtractor;
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  minio: StartedTestContainer;
  s3: S3Client;
  userId: string;
}

/**
 * Boots the real worker against real infrastructure, with only the LLM faked.
 *
 * The point is that everything the worker does in production happens here:
 * BullMQ delivers the job, Prisma runs the transaction, MinIO serves the PDF,
 * pdf.js parses it, and the domain rules validate the result. Only the network
 * call to Anthropic is replaced — because it costs money and returns something
 * different every time, not because it is inconvenient.
 */
export async function createPipelineHarness(): Promise<PipelineHarness> {
  const postgres = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('invoiceiq_test')
    .withUsername('invoiceiq')
    .withPassword('invoiceiq')
    .start();

  const redis = await new RedisContainer('redis:7-alpine').start();

  const minio = await new GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();

  const s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: s3Endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
  });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));

  const databaseUrl = postgres.getConnectionUri();
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
    S3_ENDPOINT: s3Endpoint,
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: MINIO_USER,
    S3_SECRET_ACCESS_KEY: MINIO_PASSWORD,
    S3_FORCE_PATH_STYLE: 'true',
    LLM_PROVIDER: 'fixture',
    // Deliberately not the production limiter value: a 10/minute cap would make
    // the suite take ten minutes to prove things that have nothing to do with
    // rate limiting.
    EXTRACTION_RATE_LIMIT_PER_MINUTE: '1000',
  });

  // Injected through the same token the production module uses, so the worker
  // under test is the production worker.
  const llm = new FixtureLlmExtractor(FIXTURES, 'clean-invoice');

  const moduleRef = await Test.createTestingModule({ imports: [WorkerAppModule] })
    .overrideProvider(LLM_EXTRACTOR)
    .useValue(llm)
    .compile();

  // TestingModule already *is* an application context — for a worker with no
  // HTTP surface, init() is the whole bootstrap. This is what starts the BullMQ
  // consumers, so from here the real worker is live against the real queue.
  const app = await moduleRef.init();

  const prisma = createPrismaClient({ databaseUrl });
  await prisma.$connect();

  const queue = new Queue(QUEUE_EXTRACTION, {
    connection: { url: redis.getConnectionUrl(), maxRetriesPerRequest: null },
  });

  const user = await prisma.user.create({
    data: {
      email: 'pipeline@invoiceiq.dev',
      passwordHash: 'not-used-in-this-suite',
      role: 'REVIEWER',
    },
  });

  return { app, prisma, queue, llm, postgres, redis, minio, s3, userId: user.id };
}

export async function destroyPipelineHarness(h: PipelineHarness): Promise<void> {
  await h.queue.close();
  await h.app.close();
  await h.prisma.$disconnect();
  h.s3.destroy();
  await Promise.all([h.postgres.stop(), h.redis.stop(), h.minio.stop()]);
}

/** Uploads a sample PDF and creates the matching QUEUED document row. */
export async function seedDocument(
  h: PipelineHarness,
  sample: string,
  overrides: { sha?: string } = {},
): Promise<string> {
  const bytes = await readFile(path.join(SAMPLES, `${sample}.pdf`));
  const key = `docs/${crypto.randomUUID()}.pdf`;

  await h.s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: bytes,
      ContentType: 'application/pdf',
    }),
  );

  const document = await h.prisma.document.create({
    data: {
      uploaderId: h.userId,
      originalName: `${sample}.pdf`,
      s3Key: key,
      sizeBytes: bytes.length,
      contentSha256: overrides.sha ?? crypto.randomUUID().replace(/-/g, ''),
      status: 'QUEUED',
    },
  });

  return document.id;
}

/** Enqueues extraction exactly as the API does, then waits for a terminal state. */
export async function runPipeline(h: PipelineHarness, documentId: string): Promise<void> {
  await h.queue.add(
    JOB_EXTRACT_DOCUMENT,
    { documentId, contentSha256: 'x', traceId: `test-${documentId}` },
    { jobId: documentId },
  );
  await waitForTerminal(h, documentId);
}

const TERMINAL = new Set(['COMPLETED', 'NEEDS_REVIEW', 'FAILED']);

export async function waitForTerminal(
  h: PipelineHarness,
  documentId: string,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const document = await h.prisma.document.findUnique({
      where: { id: documentId },
      select: { status: true },
    });

    if (document && TERMINAL.has(document.status)) return document.status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const final = await h.prisma.document.findUnique({ where: { id: documentId } });
  throw new Error(
    `Document ${documentId} never reached a terminal state (last: ${final?.status ?? 'missing'})`,
  );
}

export async function resetBetweenTests(h: PipelineHarness): Promise<void> {
  await h.queue.obliterate({ force: true });
  await h.prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "document_events", "validation_findings", "extractions", ' +
      '"document_chunks", "review_decisions", "documents" RESTART IDENTITY CASCADE',
  );
  h.llm.reset();
  h.llm.use('clean-invoice');
}
