import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Queue } from 'bullmq';
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  resetThrottler,
  type TestContext,
} from './helpers/test-app.js';

/**
 * Requeue: the manual recovery path.
 *
 * These exist because the feature shipped broken the first time and the bug was
 * invisible from the outside. The job id was the document id, which is right for
 * deduplicating a retried upload and wrong for "run this again": BullMQ's
 * `add()` finds the existing completed job and *returns it* rather than
 * throwing, so the endpoint answered 200, the row moved to QUEUED, and no job
 * existed to move it out again — a worse state than the failure being recovered
 * from. The assertion that would have caught it is the one below that counts
 * jobs on the queue.
 */

let ctx: TestContext;
let accessToken: string;
let userId: string;
let extractionQueue: Queue;

const api = () => request(ctx.app.getHttpServer());
const auth = () => ({
  get: (url: string) => api().get(url).set('Authorization', `Bearer ${accessToken}`),
  post: (url: string) => api().post(url).set('Authorization', `Bearer ${accessToken}`),
});

/** Creates a document directly in a given state, bypassing the upload dance. */
async function seedDocument(status: string, updatedAt?: Date) {
  const document = await ctx.prisma.client.document.create({
    data: {
      uploaderId: userId,
      originalName: 'recovery.pdf',
      s3Key: `docs/${crypto.randomUUID()}.pdf`,
      sizeBytes: 1024,
      contentSha256: crypto.randomUUID().replace(/-/g, ''),
      status: status as 'FAILED',
      ...(status === 'FAILED' ? { failureReason: 'LLM_REQUEST_REJECTED: key expired' } : {}),
    },
  });

  // `updatedAt` is maintained by Prisma, so the only way to age a row is to
  // write it explicitly afterwards.
  if (updatedAt) {
    await ctx.prisma.client.$executeRaw`
      UPDATE documents SET updated_at = ${updatedAt} WHERE id = ${document.id}::uuid
    `;
  }

  return document.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  extractionQueue = new Queue('extraction', {
    connection: { url: ctx.redis.getConnectionUrl(), maxRetriesPerRequest: null },
  });
}, 180_000);

afterAll(async () => {
  await extractionQueue?.close();
  if (ctx) await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await extractionQueue.obliterate({ force: true });
  resetThrottler(ctx.app);

  const res = await api()
    .post('/api/v1/auth/register')
    .send({ email: 'operator@invoiceiq.dev', password: 'a-sufficiently-long-password' })
    .expect(201);

  accessToken = res.body.accessToken;
  userId = res.body.user.id;
});

describe('POST /documents/:id/requeue', () => {
  it('puts a failed document back on the queue and clears its failure reason', async () => {
    const id = await seedDocument('FAILED');

    const res = await auth().post(`/api/v1/documents/${id}/requeue`).expect(200);

    expect(res.body).toMatchObject({ id, status: 'QUEUED', failureReason: null });
  });

  it('actually enqueues a job, rather than reporting success and enqueueing nothing', async () => {
    // The regression test. A 200 and a QUEUED row proved nothing here: the
    // original bug produced both while creating no job at all.
    const id = await seedDocument('FAILED');

    await auth().post(`/api/v1/documents/${id}/requeue`).expect(200);

    const jobs = await extractionQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((job) => job.data.documentId === id)).toHaveLength(1);
  });

  it('enqueues again after an earlier job for the same document already completed', async () => {
    // The exact shape of the bug: BullMQ retains completed jobs, so a second
    // add() under the same id silently returns the old one.
    const id = await seedDocument('FAILED');

    await extractionQueue.add(
      'extract-document',
      { documentId: id, contentSha256: 'x', traceId: 'earlier' },
      { jobId: id },
    );

    await auth().post(`/api/v1/documents/${id}/requeue`).expect(200);

    const jobs = await extractionQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((job) => job.data.documentId === id).length).toBeGreaterThanOrEqual(2);
  });

  it('records a RECLAIMED event naming who did it', async () => {
    const id = await seedDocument('FAILED');
    await auth().post(`/api/v1/documents/${id}/requeue`).expect(200);

    const events = await ctx.prisma.client.documentEvent.findMany({
      where: { documentId: id, type: 'RECLAIMED' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ from: 'FAILED', to: 'QUEUED', by: 'operator' });
  });

  it('refuses a completed document — the state machine has no edge back', async () => {
    const id = await seedDocument('COMPLETED');

    const res = await auth().post(`/api/v1/documents/${id}/requeue`).expect(409);

    expect(res.body.detail).toMatch(/COMPLETED document cannot be requeued/);
  });

  it('refuses a document that is still plausibly being worked on', async () => {
    const id = await seedDocument('PROCESSING');

    const res = await auth().post(`/api/v1/documents/${id}/requeue`).expect(409);

    // Says how long it has been and what the window is, so the operator is not
    // left retrying blind.
    expect(res.body.detail).toMatch(/processing for \d+ minute/);
  });

  it('allows a document stranded in PROCESSING past the threshold', async () => {
    const id = await seedDocument('PROCESSING', new Date(Date.now() - 60 * 60_000));

    await auth().post(`/api/v1/documents/${id}/requeue`).expect(200);
  });

  it('recovers a QUEUED document whose job went missing, without resetting its clock', async () => {
    // The narrow window where the transaction committed and the enqueue then
    // failed: the row says QUEUED and nothing is coming for it.
    const stale = new Date(Date.now() - 6 * 60 * 60_000);
    const id = await seedDocument('QUEUED', stale);

    await auth().post(`/api/v1/documents/${id}/requeue`).expect(200);

    const jobs = await extractionQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((job) => job.data.documentId === id)).toHaveLength(1);

    // updatedAt must NOT be bumped. Writing QUEUED over QUEUED would reset the
    // very timer that identified the document as stuck, so the janitor would
    // rediscover it every run and never actually recover it.
    const after = await ctx.prisma.client.document.findUniqueOrThrow({ where: { id } });
    expect(after.updatedAt.getTime()).toBe(stale.getTime());
  });

  it('refuses a QUEUED document that is merely waiting its turn', async () => {
    const id = await seedDocument('QUEUED');
    await auth().post(`/api/v1/documents/${id}/requeue`).expect(409);
  });

  it('404s on another user document rather than 403, so ids cannot be enumerated', async () => {
    const id = await seedDocument('FAILED');

    const other = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'nosy@invoiceiq.dev', password: 'a-sufficiently-long-password' })
      .expect(201);

    await api()
      .post(`/api/v1/documents/${id}/requeue`)
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .expect(404);
  });

  it('requires authentication', async () => {
    const id = await seedDocument('FAILED');
    await api().post(`/api/v1/documents/${id}/requeue`).expect(401);
  });
});

describe('GET /metrics', () => {
  it('404s when no token is configured, rather than 401', async () => {
    // Absent by default: an unconfigured deployment should not even confirm the
    // endpoint exists, let alone serve spend and traffic figures.
    await api().get('/api/v1/metrics').expect(404);
  });
});
