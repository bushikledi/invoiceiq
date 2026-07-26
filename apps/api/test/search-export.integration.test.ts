import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DeterministicEmbeddingProvider, toVectorLiteral } from '@invoiceiq/ai';
import { InvoiceExtractionSchema, buildChunks } from '@invoiceiq/domain';
import { Prisma } from '@invoiceiq/database';
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  resetThrottler,
  type TestContext,
} from './helpers/test-app.js';

let ctx: TestContext;
let accessToken: string;
let userId: string;

const api = () => request(ctx.app.getHttpServer());
const auth = () => ({
  get: (url: string) => api().get(url).set('Authorization', `Bearer ${accessToken}`),
  post: (url: string) => api().post(url).set('Authorization', `Bearer ${accessToken}`),
});

/**
 * The same deterministic embedder the API is configured with in tests.
 *
 * Determinism is the whole point: a real model would make "is this result
 * first?" depend on model weights, so the test could only assert that
 * *something* came back. With hash embeddings the ordering is exact and the
 * assertion is meaningful.
 */
const embedder = new DeterministicEmbeddingProvider(384);

const invoice = (overrides: Record<string, unknown> = {}) => ({
  vendor: { name: 'ACME S.r.l.', vatNumber: 'IT12345678901', address: 'Via Roma 1, Milano' },
  invoiceNumber: 'INV-233',
  issueDate: '2026-03-12',
  dueDate: '2026-04-11',
  currency: 'EUR',
  lineItems: [
    {
      description: 'Sedie ufficio ergonomiche',
      quantity: 4,
      unitPriceCents: 24_500,
      vatRatePercent: 22,
      totalCents: 98_000,
    },
  ],
  subtotalCents: 98_000,
  vatTotalCents: 21_560,
  totalCents: 119_560,
  fieldConfidence: {},
  ...overrides,
});

/** Creates a COMPLETED document with an extraction and embedded chunks. */
async function seedSearchable(name: string, data: Record<string, unknown>, rawText = '') {
  const document = await ctx.prisma.client.document.create({
    data: {
      uploaderId: userId,
      originalName: name,
      s3Key: `docs/${crypto.randomUUID()}.pdf`,
      sizeBytes: 2048,
      contentSha256: crypto.randomUUID().replace(/-/g, ''),
      status: 'COMPLETED',
    },
  });

  await ctx.prisma.client.extraction.create({
    data: {
      documentId: document.id,
      version: 1,
      data: data as Prisma.InputJsonValue,
      fieldMeta: {},
      overallConfidence: new Prisma.Decimal(0.95),
      model: 'fixture-model',
      promptVersion: 'extract-invoice.v1',
      attempts: 1,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: new Prisma.Decimal(0),
    },
  });

  const parsed = InvoiceExtractionSchema.parse(data);
  const chunks = buildChunks(rawText, parsed);
  const vectors = await embedder.embed(chunks.map((c) => c.content));

  for (const [i, chunk] of chunks.entries()) {
    await ctx.prisma.client.$executeRaw`
      INSERT INTO document_chunks (id, document_id, chunk_index, kind, content, embedding)
      VALUES (gen_random_uuid(), ${document.id}::uuid, ${chunk.index}, ${chunk.kind},
              ${chunk.content}, ${toVectorLiteral(vectors[i]!)}::vector)
    `;
  }

  return document.id;
}

beforeAll(async () => {
  // The API's own embedder must match the one seeding the chunks, or the query
  // vector lands in a different space and every result is noise.
  process.env['EMBEDDING_PROVIDER'] = 'deterministic';
  ctx = await createTestContext();
}, 180_000);

afterAll(async () => {
  if (ctx) await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetThrottler(ctx.app);

  const res = await api()
    .post('/api/v1/auth/register')
    .send({ email: 'searcher@invoiceiq.dev', password: 'a-sufficiently-long-password' })
    .expect(201);

  accessToken = res.body.accessToken;
  userId = res.body.user.id;
});

describe('semantic search', () => {
  it('finds a document and ranks it first', async () => {
    const chairsId = await seedSearchable('chairs.pdf', invoice());
    await seedSearchable(
      'consulting.pdf',
      invoice({
        invoiceNumber: 'INV-999',
        vendor: { name: 'Studio Bianchi', vatNumber: null, address: 'Roma' },
        lineItems: [
          {
            description: 'Consulenza tecnica mensile',
            quantity: 1,
            unitPriceCents: 50_000,
            vatRatePercent: 22,
            totalCents: 50_000,
          },
        ],
      }),
    );

    const res = await auth()
      .get('/api/v1/search?q=' + encodeURIComponent('Sedie ufficio ergonomiche Milano'))
      .expect(200);

    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(res.body.hits[0].documentId).toBe(chairsId);
  });

  it('returns one hit per document, not one per matching chunk', async () => {
    // A long invoice produces many chunks and several may match. Five rows of
    // the same document is a useless page of results.
    await seedSearchable('long.pdf', invoice(), 'Sedie ufficio '.repeat(2_000));

    const res = await auth().get('/api/v1/search?q=Sedie%20ufficio').expect(200);
    const ids = res.body.hits.map((h: { documentId: string }) => h.documentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the invoice facts needed to render a result card', async () => {
    await seedSearchable('chairs.pdf', invoice());
    const res = await auth().get('/api/v1/search?q=ACME').expect(200);

    expect(res.body.hits[0]).toMatchObject({
      invoiceNumber: 'INV-233',
      vendorName: 'ACME S.r.l.',
      totalCents: 119_560,
      currency: 'EUR',
    });
  });

  it('scores between 0 and 1, descending', async () => {
    await seedSearchable('a.pdf', invoice());
    await seedSearchable('b.pdf', invoice({ invoiceNumber: 'INV-500' }));

    const res = await auth().get('/api/v1/search?q=invoice').expect(200);
    const scores = res.body.hits.map((h: { score: number }) => h.score);

    for (const score of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
  });

  it('never returns another user documents', async () => {
    await seedSearchable('mine.pdf', invoice());

    const other = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'nosy@invoiceiq.dev', password: 'a-sufficiently-long-password' })
      .expect(201);

    const res = await api()
      .get('/api/v1/search?q=ACME')
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .expect(200);

    expect(res.body.hits).toEqual([]);
  });

  it('rejects a one-character query', async () => {
    await auth().get('/api/v1/search?q=a').expect(422);
  });

  it('requires authentication', async () => {
    await api().get('/api/v1/search?q=anything').expect(401);
  });

  it('treats a quote as data, not SQL', async () => {
    // The embedding and the query are bound parameters; nothing is
    // concatenated into the statement.
    await seedSearchable('a.pdf', invoice());
    await auth()
      .get(`/api/v1/search?q=${encodeURIComponent("'; DROP TABLE documents; --")}`)
      .expect(200);

    expect(await ctx.prisma.client.document.count()).toBe(1);
  });

  it('returns an empty result set rather than erroring when nothing is indexed', async () => {
    const res = await auth().get('/api/v1/search?q=anything').expect(200);
    expect(res.body.hits).toEqual([]);
    expect(res.body.tookMs).toBeGreaterThanOrEqual(0);
  });
});

describe('export', () => {
  beforeEach(async () => {
    await seedSearchable('chairs.pdf', invoice());
  });

  it('streams CSV with a header and one row per line item', async () => {
    const res = await auth().get('/api/v1/export?format=csv').expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');

    const lines = res.text.trim().split('\n');
    expect(lines[0]).toContain('document_id');
    expect(lines[0]).toContain('line_description');
    expect(lines[1]).toContain('Sedie ufficio ergonomiche');
  });

  it('writes money as a plain decimal a spreadsheet can sum', async () => {
    const res = await auth().get('/api/v1/export?format=csv').expect(200);
    // 119560 minor units must reach the sheet as 1195.60, not as cents.
    expect(res.text).toContain('1195.60');
  });

  it('neutralises a formula injection in vendor data', async () => {
    // The vendor name comes from a PDF an attacker may have supplied; Excel
    // executes a leading `=` as a formula.
    await seedSearchable(
      'evil.pdf',
      invoice({
        invoiceNumber: 'INV-666',
        vendor: { name: '=cmd|/c calc!A1', vatNumber: null, address: null },
      }),
    );

    const res = await auth().get('/api/v1/export?format=csv').expect(200);
    expect(res.text).not.toMatch(/(^|,)=cmd/m);
    expect(res.text).toContain("'=cmd");
  });

  it('emits valid JSON with amounts left in minor units', async () => {
    const res = await auth().get('/api/v1/export?format=json').expect(200);
    const parsed = JSON.parse(res.text);

    expect(Array.isArray(parsed)).toBe(true);
    // Other software consumes this; it should do arithmetic on integers rather
    // than re-parse a decimal we formatted for humans.
    expect(parsed[0].invoice.totalCents).toBe(119_560);
  });

  it('filters by status', async () => {
    const res = await auth().get('/api/v1/export?format=json&status=NEEDS_REVIEW').expect(200);
    expect(JSON.parse(res.text)).toEqual([]);
  });

  it('includes a document that has no extraction', async () => {
    // Otherwise a reconciliation against "everything I uploaded" is silently
    // short a few rows.
    await ctx.prisma.client.document.create({
      data: {
        uploaderId: userId,
        originalName: 'failed.pdf',
        s3Key: 'docs/x.pdf',
        sizeBytes: 1,
        contentSha256: 'unique-failed',
        status: 'FAILED',
      },
    });

    const res = await auth().get('/api/v1/export?format=csv').expect(200);
    expect(res.text).toContain('failed.pdf');
  });

  it('never exports another user documents', async () => {
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'nosy2@invoiceiq.dev', password: 'a-sufficiently-long-password' })
      .expect(201);

    const res = await api()
      .get('/api/v1/export?format=json')
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .expect(200);

    expect(JSON.parse(res.text)).toEqual([]);
  });
});
