import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { InvoiceExtractionSchema, isErr, isOk } from '@invoiceiq/domain';
import { extractWithRepair, buildFeedback, renderZodIssues } from './extract-with-repair.js';
import { FixtureLlmExtractor } from './adapters/fixture-extractor.js';
import { FIXTURES } from './fixtures/index.js';
import { invoiceJsonSchema } from './schema.js';
import type { LlmExtractor } from './ports/llm-extractor.js';
import { LlmError } from './ports/llm-extractor.js';

const SCHEMA = invoiceJsonSchema();
const TEXT = 'invoice text';

const extractorFor = (scenario: string) => new FixtureLlmExtractor(FIXTURES, scenario);

describe('extractWithRepair', () => {
  describe('first-attempt success', () => {
    it('parses a clean response without retrying', async () => {
      const extractor = extractorFor('clean-invoice');
      const result = await extractWithRepair(extractor, TEXT, SCHEMA);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;

      expect(result.value.attempts).toBe(1);
      expect(result.value.data.invoiceNumber).toBe('INV-233');
      expect(extractor.callCount).toBe(1);
    });

    it('sends no feedback on the first attempt', async () => {
      const extractor = extractorFor('clean-invoice');
      await extractWithRepair(extractor, TEXT, SCHEMA);
      expect(extractor.calls[0]!.feedback).toBeUndefined();
    });

    it('reports usage and model', async () => {
      const extractor = extractorFor('clean-invoice');
      const result = await extractWithRepair(extractor, TEXT, SCHEMA);

      if (!isOk(result)) throw new Error('expected success');
      expect(result.value.usage).toEqual({ inputTokens: 1_412, outputTokens: 402 });
      expect(result.value.model).toBe('fixture-model');
    });
  });

  describe('the corrective retry loop', () => {
    /** THE M6 GATE: a malformed reply must be repaired, not blindly retried. */
    it('repairs a schema failure and succeeds on the second attempt', async () => {
      const extractor = extractorFor('malformed-then-valid');
      const result = await extractWithRepair(extractor, TEXT, SCHEMA);

      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;

      expect(result.value.attempts).toBe(2);
      expect(extractor.callCount).toBe(2);
    });

    it('feeds back the SPECIFIC failures, not a generic retry', async () => {
      const extractor = extractorFor('malformed-then-valid');
      await extractWithRepair(extractor, TEXT, SCHEMA);

      const feedback = extractor.calls[1]!.feedback;
      expect(feedback).toBeDefined();

      // This is the whole point: at temperature 0 an identical prompt tends to
      // reproduce an identical failure, so the retry has to say what was wrong.
      expect(feedback).toContain('lineItems[0].totalCents');
      expect(feedback).toContain('subtotalCents');
      expect(feedback).toMatch(/int|integer/i);
      expect(feedback).not.toMatch(/try again/i);
    });

    it('tells the model not to change anything else', async () => {
      // Without this the model rewrites fields it had correct, and a repair
      // turns into a fresh extraction with new errors.
      const extractor = extractorFor('malformed-then-valid');
      await extractWithRepair(extractor, TEXT, SCHEMA);
      expect(extractor.calls[1]!.feedback).toMatch(/not change any value/i);
    });

    it('notifies the caller on each retry so an event can be recorded', async () => {
      const onRetry = vi.fn();
      await extractWithRepair(extractorFor('malformed-then-valid'), TEXT, SCHEMA, { onRetry });

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, issues: expect.any(Array) }),
      );
    });

    it('still passes the original document text on the retry', async () => {
      const extractor = extractorFor('malformed-then-valid');
      await extractWithRepair(extractor, TEXT, SCHEMA);
      expect(extractor.calls[1]!.text).toBe(TEXT);
    });
  });

  describe('exhausting retries', () => {
    it('fails with SCHEMA_FAILURE after the configured attempts', async () => {
      const extractor = extractorFor('always-malformed');
      const result = await extractWithRepair(extractor, TEXT, SCHEMA, { maxAttempts: 3 });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;

      expect(result.error.kind).toBe('SCHEMA_FAILURE');
      expect(result.error.attempts).toBe(3);
      expect(extractor.callCount).toBe(3);
    });

    it('carries the final issues so failure_reason is diagnosable', async () => {
      const result = await extractWithRepair(extractorFor('always-malformed'), TEXT, SCHEMA);

      if (!isErr(result) || result.error.kind !== 'SCHEMA_FAILURE') {
        throw new Error('expected schema failure');
      }
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues.join(' ')).toContain('totalCents');
    });

    it('accumulates usage across every attempt, including the failures', async () => {
      // We are billed for failed attempts too. Reporting only the successful
      // call would make the cost dashboard a comfortable lie.
      const result = await extractWithRepair(extractorFor('always-malformed'), TEXT, SCHEMA, {
        maxAttempts: 3,
      });

      if (!isErr(result)) throw new Error('expected failure');
      expect(result.error.usage.inputTokens).toBe(1_412 * 3);
      expect(result.error.usage.outputTokens).toBe(402 * 3);
    });

    it('respects a custom attempt limit', async () => {
      const extractor = extractorFor('always-malformed');
      await extractWithRepair(extractor, TEXT, SCHEMA, { maxAttempts: 1 });
      expect(extractor.callCount).toBe(1);
    });

    it('does not build feedback it will never send', async () => {
      const extractor = extractorFor('always-malformed');
      await extractWithRepair(extractor, TEXT, SCHEMA, { maxAttempts: 2 });
      // Two calls: the second carries feedback, and no third is attempted.
      expect(extractor.callCount).toBe(2);
      expect(extractor.calls[1]!.feedback).toBeDefined();
    });
  });

  describe('provider errors are not schema failures', () => {
    it('stops immediately on a rate limit rather than burning attempts', async () => {
      // There is nothing to repair. Retrying here would spend the document's
      // whole schema budget on a condition that has nothing to do with schemas.
      const extractor = extractorFor('rate-limited');
      const result = await extractWithRepair(extractor, TEXT, SCHEMA, { maxAttempts: 3 });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;

      expect(result.error.kind).toBe('PROVIDER_ERROR');
      expect(extractor.callCount).toBe(1);
    });

    it('marks a 429 retriable so the queue re-runs the job later', async () => {
      const result = await extractWithRepair(extractorFor('rate-limited'), TEXT, SCHEMA);
      if (!isErr(result) || result.error.kind !== 'PROVIDER_ERROR') {
        throw new Error('expected provider error');
      }
      expect(result.error.retriable).toBe(true);
    });

    it('marks a 400 terminal so the job is not retried forever', async () => {
      const result = await extractWithRepair(extractorFor('invalid-request'), TEXT, SCHEMA);
      if (!isErr(result) || result.error.kind !== 'PROVIDER_ERROR') {
        throw new Error('expected provider error');
      }
      expect(result.error.retriable).toBe(false);
    });

    it('treats an unclassified throw as retriable', async () => {
      // Losing a document to an unrecognised transient error is worse than
      // wasting a couple of attempts on a permanent one.
      const flaky: LlmExtractor = {
        extract: () => Promise.reject(new Error('socket hang up')),
      };
      const result = await extractWithRepair(flaky, TEXT, SCHEMA);
      if (!isErr(result) || result.error.kind !== 'PROVIDER_ERROR') {
        throw new Error('expected provider error');
      }
      expect(result.error.retriable).toBe(true);
    });

    it('surfaces the provider message for the log', async () => {
      const result = await extractWithRepair(extractorFor('rate-limited'), TEXT, SCHEMA);
      if (!isErr(result) || result.error.kind !== 'PROVIDER_ERROR') {
        throw new Error('expected provider error');
      }
      expect(result.error.message).toContain('429');
    });
  });

  describe('abort', () => {
    it('passes the signal through so a draining worker can cancel', async () => {
      const controller = new AbortController();
      const extractor = extractorFor('clean-invoice');
      await extractWithRepair(extractor, TEXT, SCHEMA, { signal: controller.signal });
      expect(extractor.calls[0]!.signal).toBe(controller.signal);
    });
  });
});

describe('renderZodIssues', () => {
  const parseFailure = (payload: unknown): z.ZodError => {
    const result = InvoiceExtractionSchema.safeParse(payload);
    if (result.success) throw new Error('expected a parse failure');
    return result.error;
  };

  /** Renders with the payload attached, as the retry loop does. */
  const render = (payload: unknown) => renderZodIssues(parseFailure(payload), payload);

  it('names the field path with array indices intact', () => {
    const issues = render({
      vendor: { name: 'X', vatNumber: null, address: null },
      invoiceNumber: 'A',
      issueDate: '2026-01-01',
      dueDate: null,
      currency: 'EUR',
      lineItems: [
        { description: 'a', quantity: 1, unitPriceCents: 1, vatRatePercent: 1, totalCents: 1.5 },
      ],
      subtotalCents: 1,
      vatTotalCents: 0,
      totalCents: 1,
      fieldConfidence: {},
    });

    expect(issues.some((i) => i.includes('lineItems[0].totalCents'))).toBe(true);
  });

  it('reports a missing field as missing rather than as a type error', () => {
    const issues = render({});
    expect(issues.join(' ')).toMatch(/received undefined|expected/i);
  });

  it('quotes the received value so the model can see its own mistake', () => {
    const issues = render({
      vendor: { name: 'X', vatNumber: null, address: null },
      invoiceNumber: 'A',
      issueDate: '2026-01-01',
      dueDate: null,
      currency: 'EUR',
      lineItems: [
        { description: 'a', quantity: 1, unitPriceCents: 1, vatRatePercent: 1, totalCents: 1 },
      ],
      subtotalCents: 'not-a-number',
      vatTotalCents: 0,
      totalCents: 1,
      fieldConfidence: {},
    });

    const subtotalIssue = issues.find((i) => i.startsWith('subtotalCents'));
    expect(subtotalIssue).toContain('not-a-number');
  });

  it('rejects an empty line items array with a usable message', () => {
    const issues = render({
      vendor: { name: 'X', vatNumber: null, address: null },
      invoiceNumber: 'A',
      issueDate: '2026-01-01',
      dueDate: null,
      currency: 'EUR',
      lineItems: [],
      subtotalCents: 0,
      vatTotalCents: 0,
      totalCents: 0,
      fieldConfidence: {},
    });
    expect(issues.some((i) => i.startsWith('lineItems'))).toBe(true);
  });
});

describe('buildFeedback', () => {
  it('lists every issue as a bullet', () => {
    const feedback = buildFeedback(['a: bad', 'b: worse']);
    expect(feedback).toContain('- a: bad');
    expect(feedback).toContain('- b: worse');
  });

  it('stays terse — we pay for these tokens', () => {
    const feedback = buildFeedback(['x: y']);
    expect(feedback.length).toBeLessThan(300);
  });
});

describe('LlmError', () => {
  it('survives instanceof after subclassing', () => {
    const error = new LlmError('boom', true);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toBeInstanceOf(Error);
    expect(error.retriable).toBe(true);
  });
});

describe('the fixture extractor across multiple documents', () => {
  /**
   * Regression. The worker holds ONE extractor for its whole lifetime, while
   * the response index is per-extraction state. An earlier version reset only
   * when `index === 0`, so document one resolved its scenario correctly and
   * every document after it replayed the first one's fixture — producing
   * confident, plausible, completely wrong extractions with nothing failing.
   */
  it('re-resolves the scenario for each new document', async () => {
    const extractor = new FixtureLlmExtractor(FIXTURES, 'clean-invoice', (text) =>
      text.includes('MULTI') ? 'multi-rate' : 'clean-invoice',
    );

    const first = await extractWithRepair(extractor, 'a clean one', SCHEMA);
    const second = await extractWithRepair(extractor, 'a MULTI rate one', SCHEMA);
    const third = await extractWithRepair(extractor, 'a clean one again', SCHEMA);

    if (!isOk(first) || !isOk(second) || !isOk(third)) throw new Error('expected success');

    expect(first.value.data.invoiceNumber).toBe('INV-233');
    expect(second.value.data.invoiceNumber).toBe('INV-270');
    // The third must go back to the clean fixture, not stay on multi-rate.
    expect(third.value.data.invoiceNumber).toBe('INV-233');
  });

  it('resolves once per extraction, not once per attempt', async () => {
    // A corrective retry carries feedback and must stay on the scenario it
    // started with — re-resolving mid-repair would judge the repair against a
    // different document.
    const extractor = new FixtureLlmExtractor(FIXTURES, 'malformed-then-valid');
    const result = await extractWithRepair(extractor, 'anything', SCHEMA);

    if (!isOk(result)) throw new Error('expected success');
    expect(result.value.attempts).toBe(2);

    // The position within a multi-response scenario comes from the request, not
    // from instance state — which is what makes a shared extractor safe when
    // two documents are processed concurrently.
    expect(extractor.calls.map((c) => c.attempt)).toEqual([1, 2]);
  });

  it('serves interleaved documents correctly, as concurrency 2 produces', async () => {
    // The regression this guards: with per-instance scenario state, two
    // documents in flight at once each read the other's fixture, producing
    // extractions that parsed and scored fine but belonged to a different
    // invoice. Nothing threw.
    const extractor = new FixtureLlmExtractor(FIXTURES, 'clean-invoice', (text) =>
      text.includes('MULTI') ? 'multi-rate' : 'clean-invoice',
    );

    const [a, b, c] = await Promise.all([
      extractWithRepair(extractor, 'plain one', SCHEMA),
      extractWithRepair(extractor, 'a MULTI rate one', SCHEMA),
      extractWithRepair(extractor, 'another plain one', SCHEMA),
    ]);

    if (!isOk(a) || !isOk(b) || !isOk(c)) throw new Error('expected success');
    expect(a.value.data.invoiceNumber).toBe('INV-233');
    expect(b.value.data.invoiceNumber).toBe('INV-270');
    expect(c.value.data.invoiceNumber).toBe('INV-233');
  });
});
