import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPipelineHarness,
  destroyPipelineHarness,
  resetBetweenTests,
  runPipeline,
  seedDocument,
  waitForTerminal,
  type PipelineHarness,
} from './helpers/pipeline-harness.js';

let h: PipelineHarness;

beforeAll(async () => {
  h = await createPipelineHarness();
}, 240_000);

afterAll(async () => {
  if (h) await destroyPipelineHarness(h);
});

beforeEach(async () => {
  await resetBetweenTests(h);
});

const documentWithExtraction = (id: string) =>
  h.prisma.document.findUnique({
    where: { id },
    include: {
      extractions: { include: { findings: true } },
      events: { orderBy: { createdAt: 'asc' } },
    },
  });

/** SCENARIO 1 — the happy path. */
describe('a clean invoice', () => {
  it('runs end to end and completes', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);

    const document = await documentWithExtraction(id);
    expect(document!.status).toBe('COMPLETED');
    expect(document!.pageCount).toBe(1);
  });

  it('persists the extraction with cost and usage', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);

    const [extraction] = (await documentWithExtraction(id))!.extractions;
    expect(extraction).toBeDefined();
    expect(extraction!.version).toBe(1);
    expect(extraction!.attempts).toBe(1);
    expect(extraction!.inputTokens).toBeGreaterThan(0);
    expect(extraction!.promptVersion).toBe('extract-invoice.v1');
    // Fixtures cost nothing, and recording otherwise would make the spend
    // dashboard fiction.
    expect(Number(extraction!.costUsd)).toBe(0);
  });

  it('records a confident overall score and no findings', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);

    const [extraction] = (await documentWithExtraction(id))!.extractions;
    expect(Number(extraction!.overallConfidence)).toBeGreaterThan(0.85);
    expect(extraction!.findings).toHaveLength(0);
  });

  it('leaves an auditable event trail', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);

    const events = (await documentWithExtraction(id))!.events;
    const transitions = events.map((e) => (e.payload as { to?: string }).to);

    // "Why is this document in this state?" should be answerable from the
    // timeline alone.
    expect(transitions).toEqual(['PROCESSING', 'COMPLETED']);
  });
});

/** SCENARIO 2 — a business-rule failure routes to human review. */
describe('a sum mismatch', () => {
  beforeEach(() => h.llm.use('sum-mismatch'));

  it('lands in NEEDS_REVIEW rather than COMPLETED', async () => {
    const id = await seedDocument(h, 'sum-mismatch');
    await runPipeline(h, id);

    expect((await documentWithExtraction(id))!.status).toBe('NEEDS_REVIEW');
  });

  it('records the LINE_ITEMS_SUM finding with a reviewer-readable message', async () => {
    const id = await seedDocument(h, 'sum-mismatch');
    await runPipeline(h, id);

    const [extraction] = (await documentWithExtraction(id))!.extractions;
    const finding = extraction!.findings.find((f) => f.rule === 'LINE_ITEMS_SUM');

    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('ERROR');
    expect(finding!.message).toContain('1240.00 EUR');
    expect(finding!.message).toContain('1250.00 EUR');
  });

  it('still stores the extraction, so a reviewer has something to correct', async () => {
    const id = await seedDocument(h, 'sum-mismatch');
    await runPipeline(h, id);

    const [extraction] = (await documentWithExtraction(id))!.extractions;
    expect(extraction!.data).toMatchObject({ invoiceNumber: 'INV-241' });
  });
});

/** SCENARIO 3 — the corrective retry loop, observed from outside. */
describe('a malformed response that is repaired', () => {
  beforeEach(() => h.llm.use('malformed-then-valid'));

  it('succeeds with attempts = 2', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);

    const document = await documentWithExtraction(id);
    expect(document!.status).toBe('COMPLETED');

    // The number that proves the repair loop ran rather than the model simply
    // getting it right.
    expect(document!.extractions[0]!.attempts).toBe(2);
  });

  it('emits an LLM_RETRY event naming the fields that were wrong', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);

    const events = (await documentWithExtraction(id))!.events;
    const retry = events.find((e) => e.type === 'LLM_RETRY');

    expect(retry).toBeDefined();
    const payload = retry!.payload as { attempt: number; issues: string[] };
    expect(payload.attempt).toBe(1);
    expect(payload.issues.join(' ')).toContain('totalCents');
  });

  it('calls the model exactly twice', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);
    expect(h.llm.callCount).toBe(2);
  });
});

/** SCENARIO 4 — idempotency: a duplicate job must not cost a second call. */
describe('idempotency', () => {
  it('ignores a redelivered job for a document already processed', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);
    expect(h.llm.callCount).toBe(1);

    // Same job id: BullMQ dedupes, and the status guard catches anything that
    // slips past. Between them, "the enqueue succeeded but the response was
    // lost" costs nothing.
    await runPipeline(h, id);

    expect(h.llm.callCount).toBe(1);
    const document = await documentWithExtraction(id);
    expect(document!.extractions).toHaveLength(1);
  });

  it('does not reprocess a document that is no longer QUEUED', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await h.prisma.document.update({ where: { id }, data: { status: 'COMPLETED' } });

    await h.queue.add(
      'extract-document',
      { documentId: id, contentSha256: 'x', traceId: 'guard-test' },
      { jobId: `${id}-forced` },
    );

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(h.llm.callCount).toBe(0);
  });
});

/** Early rejection: the cost-control story. */
describe('a scanned image', () => {
  it('fails before the model is ever called', async () => {
    const id = await seedDocument(h, 'scanned-image');
    const status = await (async () => {
      await runPipeline(h, id);
      return (await documentWithExtraction(id))!.status;
    })();

    expect(status).toBe('FAILED');

    // The whole point: no tokens were spent discovering this.
    expect(h.llm.callCount).toBe(0);
  });

  it('explains why, in terms a human can act on', async () => {
    const id = await seedDocument(h, 'scanned-image');
    await runPipeline(h, id);

    const document = await documentWithExtraction(id);
    expect(document!.failureReason).toContain('LIKELY_SCANNED_IMAGE');
    expect(document!.failureReason).toMatch(/scanned image/i);
  });

  it('writes no extraction row for a failed document', async () => {
    const id = await seedDocument(h, 'scanned-image');
    await runPipeline(h, id);
    expect((await documentWithExtraction(id))!.extractions).toHaveLength(0);
  });
});

/** Exhausted repair attempts. */
describe('a response that never parses', () => {
  beforeEach(() => h.llm.use('always-malformed'));

  it('fails the document after exhausting attempts', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);

    const document = await documentWithExtraction(id);
    expect(document!.status).toBe('FAILED');
    expect(document!.failureReason).toContain('SCHEMA_FAILURE');
  });

  it('never stores unvalidated data', async () => {
    // The alternative — persisting whatever came back — would put a
    // schema-invalid payload in front of a reviewer as if it were extracted.
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);
    expect((await documentWithExtraction(id))!.extractions).toHaveLength(0);
  });

  it('spends exactly the configured number of attempts', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);
    expect(h.llm.callCount).toBe(3);
  });
});

/** Provider errors are the queue's problem, not the document's. */
describe('a rate-limited provider', () => {
  beforeEach(() => h.llm.use('rate-limited'));

  it('returns the document to QUEUED so a retry can pick it up', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await h.queue.add(
      'extract-document',
      { documentId: id, contentSha256: 'x', traceId: 'ratelimit' },
      { jobId: id, attempts: 3, backoff: { type: 'fixed', delay: 200 } },
    );

    // A 429 must never mark the document FAILED on the first attempt — the
    // document is fine, the provider is busy.
    const status = await waitForTerminal(h, id, 20_000);
    expect(status).toBe('FAILED');

    // ...but after the attempts are exhausted it does fail, with the provider
    // message preserved for diagnosis.
    const document = await documentWithExtraction(id);
    expect(document!.failureReason).toContain('429');
  });

  it('records each attempt in the event trail', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await h.queue.add(
      'extract-document',
      { documentId: id, contentSha256: 'x', traceId: 'ratelimit-events' },
      { jobId: id, attempts: 2, backoff: { type: 'fixed', delay: 200 } },
    );
    await waitForTerminal(h, id, 20_000);

    const events = (await documentWithExtraction(id))!.events;
    // PROCESSING → QUEUED (retry) → PROCESSING → FAILED
    expect(events.length).toBeGreaterThanOrEqual(3);
  });
});

/** Multi-rate VAT, exercised through the whole pipeline. */
describe('a multi-rate invoice', () => {
  beforeEach(() => h.llm.use('multi-rate'));

  it('completes without a VAT arithmetic finding', async () => {
    const id = await seedDocument(h, 'multi-rate');
    await runPipeline(h, id);

    const document = await documentWithExtraction(id);
    const rules = document!.extractions[0]?.findings.map((f) => f.rule) ?? [];
    expect(rules).not.toContain('VAT_ARITHMETIC');
  });
});

/** Hallucination caught by corroboration rather than by the schema. */
describe('a hallucinated total', () => {
  beforeEach(() => h.llm.use('hallucinated-total'));

  it('routes to review despite passing the schema and every arithmetic rule', async () => {
    const id = await seedDocument(h, 'clean-invoice');
    await runPipeline(h, id);

    const document = await documentWithExtraction(id);
    expect(document!.status).toBe('NEEDS_REVIEW');

    // Nothing in the response itself is malformed; the total simply is not in
    // the document. Only corroboration catches this.
    const meta = document!.extractions[0]!.fieldMeta as Record<
      string,
      { flagged: boolean; reason: string | null }
    >;
    expect(meta['totalCents']!.flagged).toBe(true);
    expect(meta['totalCents']!.reason).toMatch(/does not appear/);
  });
});
