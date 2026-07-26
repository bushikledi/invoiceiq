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

let ctx: TestContext;
let accessToken: string;
let extractionQueue: Queue;

const api = () => request(ctx.app.getHttpServer());

/**
 * Supertest attaches headers to a *request*, not to the agent, so the bearer
 * token has to be applied after choosing the verb.
 */
const auth = () => ({
  get: (url: string) => api().get(url).set('Authorization', `Bearer ${accessToken}`),
  post: (url: string) => api().post(url).set('Authorization', `Bearer ${accessToken}`),
});

/** A byte-for-byte valid minimal PDF: correct signature, header and trailer. */
const VALID_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
  'ascii',
);

/** Right extension, right declared content type, wrong actual bytes. */
const DISGUISED_EXECUTABLE = Buffer.from('MZ\x90\x00This is not a PDF at all', 'binary');

async function login(email = 'uploader@invoiceiq.dev'): Promise<string> {
  const res = await api()
    .post('/api/v1/auth/register')
    .send({ email, password: 'a-sufficiently-long-password' })
    .expect(201);
  return res.body.accessToken as string;
}

/** Runs the full three-step upload dance and returns the final document. */
async function upload(bytes: Buffer, filename = 'invoice.pdf') {
  const presign = await auth()
    .post('/api/v1/documents/uploads')
    .send({ filename, sizeBytes: bytes.length, contentType: 'application/pdf' })
    .expect(201);

  // PUT straight to storage, exactly as the browser would — the API never sees
  // these bytes.
  // undici computes Content-Length from the body and rejects a manually-set
  // one, so only Content-Type is passed explicitly. The length still has to
  // match what was signed — that is exactly what this asserts.
  const put = await fetch(presign.body.uploadUrl, {
    method: 'PUT',
    body: new Uint8Array(bytes),
    headers: { 'Content-Type': 'application/pdf' },
  });
  expect(put.ok).toBe(true);

  return {
    presign: presign.body,
    complete: auth().post(`/api/v1/documents/${presign.body.documentId}/complete`),
  };
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
  resetThrottler(ctx.app);
  await extractionQueue.obliterate({ force: true });
  accessToken = await login();
});

describe('presigned upload', () => {
  it('returns a presigned URL and a document in UPLOADED', async () => {
    const res = await auth()
      .post('/api/v1/documents/uploads')
      .send({ filename: 'invoice.pdf', sizeBytes: 1024, contentType: 'application/pdf' })
      .expect(201);

    expect(res.body.uploadUrl).toContain('X-Amz-Signature');
    expect(res.body.s3Key).toMatch(/^docs\/[0-9a-f-]{36}\.pdf$/);

    const doc = await auth().get(`/api/v1/documents/${res.body.documentId}`).expect(200);
    expect(doc.body.status).toBe('UPLOADED');
  });

  it('never derives the storage key from the client filename', async () => {
    // A key built from user input is a path-traversal and key-collision bug
    // waiting to happen. The key is a server-generated UUID, always.
    const res = await auth()
      .post('/api/v1/documents/uploads')
      .send({
        filename: '../../../etc/passwd.pdf',
        sizeBytes: 1024,
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(res.body.s3Key).toMatch(/^docs\/[0-9a-f-]{36}\.pdf$/);
    expect(res.body.s3Key).not.toContain('..');
    expect(res.body.s3Key).not.toContain('passwd');
  });

  it('rejects a file larger than the limit before any bytes move', async () => {
    const res = await auth()
      .post('/api/v1/documents/uploads')
      .send({ filename: 'huge.pdf', sizeBytes: 11 * 1024 * 1024, contentType: 'application/pdf' })
      .expect(422);
    expect(res.body.type).toBe('validation_error');
  });

  it('rejects a non-PDF content type', async () => {
    await auth()
      .post('/api/v1/documents/uploads')
      .send({ filename: 'sheet.xlsx', sizeBytes: 1024, contentType: 'application/vnd.ms-excel' })
      .expect(422);
  });

  it('requires authentication', async () => {
    await api()
      .post('/api/v1/documents/uploads')
      .send({ filename: 'x.pdf', sizeBytes: 10, contentType: 'application/pdf' })
      .expect(401);
  });
});

describe('completion is the trust boundary', () => {
  it('accepts a real PDF, moves it to QUEUED and enqueues extraction', async () => {
    const { presign, complete } = await upload(VALID_PDF);
    const res = await complete.expect(200);

    expect(res.body.status).toBe('QUEUED');

    // The job must land on the queue the worker actually consumes, keyed by
    // document id so a retried request cannot double-bill the LLM.
    const job = await extractionQueue.getJob(presign.documentId);
    expect(job).toBeDefined();
    expect(job!.name).toBe('extract-document');
    expect(job!.data.documentId).toBe(presign.documentId);
    expect(job!.data.traceId).toEqual(expect.any(String));
  });

  it('records the status change as an audit event', async () => {
    const { presign, complete } = await upload(VALID_PDF);
    await complete.expect(200);

    const events = await ctx.prisma.client.documentEvent.findMany({
      where: { documentId: presign.documentId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('STATUS_CHANGED');
    expect(events[0]!.payload).toMatchObject({ from: 'UPLOADED', to: 'QUEUED' });
  });

  it('REJECTS a file that claims to be a PDF but is not', async () => {
    // The presigned PUT was signed for application/pdf and the client duly sent
    // that header — only the bytes give it away. This is why the server reads
    // the object back instead of believing the request.
    const { presign, complete } = await upload(DISGUISED_EXECUTABLE, 'invoice.pdf');
    const res = await complete.expect(422);

    expect(res.body.detail).toContain('%PDF-');

    const doc = await ctx.prisma.client.document.findUnique({ where: { id: presign.documentId } });
    expect(doc!.status).toBe('FAILED');
    expect(doc!.failureReason).toContain('%PDF-');
  });

  it('rejects completion when nothing was actually uploaded', async () => {
    const presign = await auth()
      .post('/api/v1/documents/uploads')
      .send({ filename: 'ghost.pdf', sizeBytes: 1024, contentType: 'application/pdf' })
      .expect(201);

    // Client claims success without ever performing the PUT.
    const res = await auth()
      .post(`/api/v1/documents/${presign.body.documentId}/complete`)
      .expect(422);
    expect(res.body.detail).toContain('No object');
  });

  it('is idempotent: completing twice does not enqueue a second job', async () => {
    const { presign, complete } = await upload(VALID_PDF);
    await complete.expect(200);
    await auth().post(`/api/v1/documents/${presign.documentId}/complete`).expect(200);

    const counts = await extractionQueue.getJobCounts();
    expect(counts.waiting + counts.active + counts.completed).toBe(1);
  });

  it('stores the sha256 of the actual bytes', async () => {
    const { presign, complete } = await upload(VALID_PDF);
    await complete.expect(200);

    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(VALID_PDF).digest('hex');

    const doc = await ctx.prisma.client.document.findUnique({ where: { id: presign.documentId } });
    expect(doc!.contentSha256).toBe(expected);
  });
});

describe('deduplication', () => {
  it('returns the original document when the same bytes are uploaded again', async () => {
    const first = await upload(VALID_PDF, 'invoice.pdf');
    const firstDoc = await first.complete.expect(200);

    const second = await upload(VALID_PDF, 'invoice-copy.pdf');
    const secondDoc = await second.complete.expect(200);

    // Same content hash means the same document: no duplicate row, and no
    // second LLM bill.
    expect(secondDoc.body.id).toBe(firstDoc.body.id);

    const total = await ctx.prisma.client.document.count();
    expect(total).toBe(1);
  });

  it('lets two different users upload identical bytes independently', async () => {
    const { complete: firstComplete } = await upload(VALID_PDF);
    await firstComplete.expect(200);

    // Dedupe is scoped per uploader — one user's document must never be
    // handed to another.
    accessToken = await login('second-uploader@invoiceiq.dev');
    const { complete: secondComplete } = await upload(VALID_PDF);
    await secondComplete.expect(200);

    expect(await ctx.prisma.client.document.count()).toBe(2);
  });

  it('allows several uploads to be in flight at once', async () => {
    // contentSha256 is NULL until completion, and NULLs are distinct in a
    // unique index — otherwise the second pending upload would collide.
    for (let i = 0; i < 3; i++) {
      await auth()
        .post('/api/v1/documents/uploads')
        .send({ filename: `pending-${i}.pdf`, sizeBytes: 1024, contentType: 'application/pdf' })
        .expect(201);
    }
    expect(await ctx.prisma.client.document.count()).toBe(3);
  });
});

describe('listing', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i++) {
      const bytes = Buffer.concat([VALID_PDF, Buffer.from(`unique-${i}`)]);
      const { complete } = await upload(bytes, `invoice-${i}.pdf`);
      await complete.expect(200);
    }
  });

  it('returns newest first', async () => {
    const res = await auth().get('/api/v1/documents').expect(200);
    expect(res.body.items).toHaveLength(5);

    const times = res.body.items.map((d: { createdAt: string }) => d.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('paginates with a stable cursor', async () => {
    const page1 = await auth().get('/api/v1/documents?limit=2').expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await auth()
      .get(`/api/v1/documents?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .expect(200);

    // No overlap between pages — the whole point of keyset pagination.
    const ids1 = (page1.body.items as { id: string }[]).map((d) => d.id);
    const ids2 = (page2.body.items as { id: string }[]).map((d) => d.id);
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
  });

  it('reports no further page at the end', async () => {
    const res = await auth().get('/api/v1/documents?limit=100').expect(200);
    expect(res.body.nextCursor).toBeNull();
  });

  it('filters by status', async () => {
    const queued = await auth().get('/api/v1/documents?status=QUEUED').expect(200);
    expect(queued.body.items).toHaveLength(5);

    const completed = await auth().get('/api/v1/documents?status=COMPLETED').expect(200);
    expect(completed.body.items).toHaveLength(0);
  });

  it('rejects a malformed cursor rather than ignoring it', async () => {
    const res = await auth().get('/api/v1/documents?cursor=!!!not-base64!!!').expect(422);
    expect(res.body.type).toBe('validation_error');
  });

  it('never leaks another user documents', async () => {
    accessToken = await login('nosy@invoiceiq.dev');
    const res = await auth().get('/api/v1/documents').expect(200);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('ownership isolation', () => {
  it('returns 404, not 403, for another user document', async () => {
    const { presign, complete } = await upload(VALID_PDF);
    await complete.expect(200);

    accessToken = await login('other@invoiceiq.dev');

    // 404 rather than 403 on purpose: a 403 would confirm the id exists,
    // turning the endpoint into an enumeration oracle.
    await auth().get(`/api/v1/documents/${presign.documentId}`).expect(404);
    await auth().post(`/api/v1/documents/${presign.documentId}/complete`).expect(404);
    await auth().get(`/api/v1/documents/${presign.documentId}/file`).expect(404);
  });

  it('rejects a non-UUID id without touching the database', async () => {
    await auth().get('/api/v1/documents/not-a-uuid').expect(422);
  });
});

describe('file access', () => {
  it('hands back a short-lived presigned GET that actually serves the bytes', async () => {
    const { presign, complete } = await upload(VALID_PDF);
    await complete.expect(200);

    const res = await auth().get(`/api/v1/documents/${presign.documentId}/file`).expect(200);
    expect(res.body.expiresInSeconds).toBeGreaterThan(0);

    const download = await fetch(res.body.url);
    expect(download.ok).toBe(true);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(VALID_PDF);
  });
});
