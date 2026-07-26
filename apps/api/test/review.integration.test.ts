import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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

/** An internally consistent invoice: 2 x 100.00 = 200.00, 22% VAT, total 244.00 */
const CLEAN_DATA = {
  vendor: { name: 'ACME S.r.l.', vatNumber: 'IT12345678901', address: 'Via Roma 1, Milano' },
  invoiceNumber: 'INV-233',
  issueDate: '2026-03-12',
  dueDate: '2026-04-11',
  currency: 'EUR',
  lineItems: [
    {
      description: 'Sedie ufficio',
      quantity: 2,
      unitPriceCents: 10_000,
      vatRatePercent: 22,
      totalCents: 20_000,
    },
  ],
  subtotalCents: 20_000,
  vatTotalCents: 4_400,
  totalCents: 24_400,
  fieldConfidence: { totalCents: 0.6 },
};

/** Subtotal claims 250.00 while the single line totals 200.00. */
const MISMATCHED_DATA = { ...CLEAN_DATA, subtotalCents: 25_000, totalCents: 29_400 };

async function seedNeedsReview(data: unknown = MISMATCHED_DATA) {
  const document = await ctx.prisma.client.document.create({
    data: {
      uploaderId: userId,
      originalName: 'invoice.pdf',
      s3Key: `docs/${crypto.randomUUID()}.pdf`,
      sizeBytes: 2048,
      contentSha256: crypto.randomUUID().replace(/-/g, ''),
      status: 'NEEDS_REVIEW',
    },
  });

  const extraction = await ctx.prisma.client.extraction.create({
    data: {
      documentId: document.id,
      version: 1,
      data: data as Prisma.InputJsonValue,
      fieldMeta: {
        totalCents: {
          path: 'totalCents',
          score: 0.6,
          flagged: true,
          selfReport: 0.6,
          presence: 1,
          corroboration: 1,
          reason: 'The model reported low confidence in this value',
        },
      },
      overallConfidence: new Prisma.Decimal(0.72),
      model: 'fixture-model',
      promptVersion: 'extract-invoice.v1',
      attempts: 1,
      inputTokens: 1_412,
      outputTokens: 402,
      costUsd: new Prisma.Decimal(0),
    },
  });

  await ctx.prisma.client.validationFinding.create({
    data: {
      extractionId: extraction.id,
      rule: 'LINE_ITEMS_SUM',
      severity: 'ERROR',
      fieldPath: 'subtotalCents',
      message: 'Line items sum to 200.00 EUR but the subtotal says 250.00 EUR (off by 50.00 EUR).',
    },
  });

  return document.id;
}

beforeAll(async () => {
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
    .send({ email: 'reviewer@invoiceiq.dev', password: 'a-sufficiently-long-password' })
    .expect(201);

  accessToken = res.body.accessToken;
  userId = res.body.user.id;
});

describe('document detail', () => {
  it('returns document, extraction, findings and events in one call', async () => {
    const id = await seedNeedsReview();
    const res = await auth().get(`/api/v1/documents/${id}/detail`).expect(200);

    expect(res.body.status).toBe('NEEDS_REVIEW');
    expect(res.body.extraction.version).toBe(1);
    expect(res.body.extraction.findings).toHaveLength(1);
    expect(res.body.extraction.findings[0].rule).toBe('LINE_ITEMS_SUM');
  });

  it('returns confidence as a number, not a Decimal string', async () => {
    // Prisma Decimal serialises as a string, which would make every numeric
    // comparison in the UI a silent string comparison.
    const id = await seedNeedsReview();
    const res = await auth().get(`/api/v1/documents/${id}/detail`).expect(200);

    expect(typeof res.body.extraction.overallConfidence).toBe('number');
    expect(typeof res.body.extraction.costUsd).toBe('number');
  });

  it('exposes per-field confidence with a reason for the tooltip', async () => {
    const id = await seedNeedsReview();
    const res = await auth().get(`/api/v1/documents/${id}/detail`).expect(200);

    expect(res.body.extraction.fieldMeta.totalCents).toMatchObject({
      flagged: true,
      reason: expect.stringContaining('low confidence'),
    });
  });

  it('serialises BigInt event ids as strings', async () => {
    // JSON.stringify throws outright on BigInt; the id is an opaque handle
    // to the client anyway.
    const id = await seedNeedsReview();
    await ctx.prisma.client.documentEvent.create({
      data: { documentId: id, type: 'STATUS_CHANGED', payload: { to: 'NEEDS_REVIEW' } },
    });

    const res = await auth().get(`/api/v1/documents/${id}/detail`).expect(200);
    expect(typeof res.body.events[0].id).toBe('string');
  });

  it('returns 404 for another user document', async () => {
    const id = await seedNeedsReview();

    const other = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'other@invoiceiq.dev', password: 'a-sufficiently-long-password' })
      .expect(201);

    await api()
      .get(`/api/v1/documents/${id}/detail`)
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .expect(404);
  });
});

describe('the server is the authority on corrections', () => {
  /** THE M8 GATE: a correction that still fails the rules must be rejected. */
  it('REJECTS a correction that still fails validation', async () => {
    const id = await seedNeedsReview();

    // The reviewer "fixes" the subtotal to another wrong value. The UI might
    // happily render it; the server must not accept it.
    const res = await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({ action: 'CORRECTED', corrections: [{ path: 'subtotalCents', value: 22_000 }] })
      .expect(422);

    expect(res.body.type).toBe('validation_error');
    expect(res.body.errors[0].message).toMatch(/sum to/i);

    // And the document stays where it was.
    const after = await auth().get(`/api/v1/documents/${id}/detail`).expect(200);
    expect(after.body.status).toBe('NEEDS_REVIEW');
  });

  it('accepts a correction that genuinely fixes the arithmetic', async () => {
    const id = await seedNeedsReview();

    const res = await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({
        action: 'CORRECTED',
        corrections: [
          { path: 'subtotalCents', value: 20_000 },
          { path: 'totalCents', value: 24_400 },
        ],
      })
      .expect(200);

    expect(res.body.document.status).toBe('COMPLETED');
    expect(res.body.newVersion).toBe(2);
  });

  it('creates version 2 rather than mutating version 1', async () => {
    const id = await seedNeedsReview();
    await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({
        action: 'CORRECTED',
        corrections: [
          { path: 'subtotalCents', value: 20_000 },
          { path: 'totalCents', value: 24_400 },
        ],
      })
      .expect(200);

    const versions = await ctx.prisma.client.extraction.findMany({
      where: { documentId: id },
      orderBy: { version: 'asc' },
    });

    // Keeping v1 is what lets us ask later how often the model was wrong.
    expect(versions).toHaveLength(2);
    expect((versions[0]!.data as { subtotalCents: number }).subtotalCents).toBe(25_000);
    expect((versions[1]!.data as { subtotalCents: number }).subtotalCents).toBe(20_000);
  });

  it('marks corrected fields as human-sourced with full confidence', async () => {
    const id = await seedNeedsReview();
    const res = await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({
        action: 'CORRECTED',
        corrections: [
          { path: 'subtotalCents', value: 20_000 },
          { path: 'totalCents', value: 24_400 },
        ],
      })
      .expect(200);

    const meta = res.body.document.extraction.fieldMeta;
    expect(meta.totalCents.flagged).toBe(false);
    expect(meta.totalCents.score).toBe(1);
  });

  it('resolves the original findings rather than deleting them', async () => {
    const id = await seedNeedsReview();
    await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({
        action: 'CORRECTED',
        corrections: [
          { path: 'subtotalCents', value: 20_000 },
          { path: 'totalCents', value: 24_400 },
        ],
      })
      .expect(200);

    // The audit trail should show a problem existed and was addressed.
    const findings = await ctx.prisma.client.validationFinding.findMany({
      where: { rule: 'LINE_ITEMS_SUM' },
    });
    expect(findings[0]!.resolvedAt).not.toBeNull();
  });

  it('records the reviewer decision with the corrections applied', async () => {
    const id = await seedNeedsReview();
    await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({
        action: 'CORRECTED',
        corrections: [
          { path: 'subtotalCents', value: 20_000 },
          { path: 'totalCents', value: 24_400 },
        ],
      })
      .expect(200);

    const decision = await ctx.prisma.client.reviewDecision.findFirstOrThrow({
      where: { documentId: id },
    });
    expect(decision.action).toBe('CORRECTED');
    expect(decision.reviewerId).toBe(userId);
    expect(decision.corrections).toHaveLength(2);
  });
});

describe('correction paths are not a write primitive', () => {
  it('refuses to write to __proto__', async () => {
    const id = await seedNeedsReview();
    // Applying a client-supplied path without checking is how prototype
    // pollution happens. This must be rejected outright.
    await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({ action: 'CORRECTED', corrections: [{ path: '__proto__.isAdmin', value: true }] })
      .expect(422);
  });

  it('rejects an unknown field rather than silently adding it', async () => {
    const id = await seedNeedsReview();
    const res = await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({ action: 'CORRECTED', corrections: [{ path: 'totlaCents', value: 1 }] })
      .expect(422);

    expect(res.body.detail).toMatch(/unknown field/i);
  });

  it('rejects an out-of-range line item index', async () => {
    const id = await seedNeedsReview();
    await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({
        action: 'CORRECTED',
        corrections: [{ path: 'lineItems[9].totalCents', value: 1 }],
      })
      .expect(422);
  });

  it('rejects a value of the wrong type', async () => {
    const id = await seedNeedsReview();
    await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({ action: 'CORRECTED', corrections: [{ path: 'totalCents', value: 'lots' }] })
      .expect(422);
  });

  it('corrects a nested line item field', async () => {
    const id = await seedNeedsReview(CLEAN_DATA);
    const res = await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({
        action: 'CORRECTED',
        corrections: [{ path: 'lineItems[0].description', value: 'Sedie ufficio ergonomiche' }],
      })
      .expect(200);

    expect(res.body.document.extraction.data.lineItems[0].description).toBe(
      'Sedie ufficio ergonomiche',
    );
  });
});

describe('approve and reject', () => {
  it('approves a document whose data already passes', async () => {
    const id = await seedNeedsReview(CLEAN_DATA);
    const res = await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({ action: 'APPROVED' })
      .expect(200);

    expect(res.body.document.status).toBe('COMPLETED');
    // No corrections means no new version to create.
    expect(res.body.newVersion).toBeNull();
  });

  it('refuses to approve data that still fails the rules', async () => {
    // Pressing approve does not make broken arithmetic correct.
    const id = await seedNeedsReview(MISMATCHED_DATA);
    await auth().post(`/api/v1/documents/${id}/review`).send({ action: 'APPROVED' }).expect(422);
  });

  it('requires a note when rejecting', async () => {
    const id = await seedNeedsReview();
    await auth().post(`/api/v1/documents/${id}/review`).send({ action: 'REJECTED' }).expect(422);
  });

  it('records a rejection and leaves the document for review', async () => {
    const id = await seedNeedsReview();
    const res = await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({ action: 'REJECTED', note: 'Vendor disputes this invoice' })
      .expect(200);

    // Rejection is a decision, not a fix — the document stays in the queue.
    expect(res.body.document.status).toBe('NEEDS_REVIEW');
  });

  it('rejects a review on a document that is not awaiting review', async () => {
    const id = await seedNeedsReview(CLEAN_DATA);
    await auth().post(`/api/v1/documents/${id}/review`).send({ action: 'APPROVED' }).expect(200);

    const res = await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({ action: 'APPROVED' })
      .expect(409);
    expect(res.body.type).toBe('conflict');
  });

  it('requires at least one correction for a CORRECTED action', async () => {
    const id = await seedNeedsReview();
    await auth()
      .post(`/api/v1/documents/${id}/review`)
      .send({ action: 'CORRECTED', corrections: [] })
      .expect(422);
  });
});
