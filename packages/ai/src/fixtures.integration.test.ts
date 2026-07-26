import { describe, expect, it } from 'vitest';
import {
  assessConfidence,
  fixedClock,
  hasBlockingFinding,
  isOk,
  validateInvoice,
} from '@invoiceiq/domain';
import { extractWithRepair } from './extract-with-repair.js';
import { FixtureLlmExtractor } from './adapters/fixture-extractor.js';
import { CLEAN_INVOICE_TEXT, FIXTURES } from './fixtures/index.js';
import { invoiceJsonSchema } from './schema.js';
import { computeCostUsd } from './pricing.js';

/**
 * Runs each fixture through the real domain rules.
 *
 * Fixtures are only useful if they exercise the behaviour they claim to. A
 * "sum-mismatch" scenario whose numbers happen to add up would make the
 * pipeline tests pass while proving nothing — so each one is asserted against
 * the same validators the worker will use in production.
 *
 * This is also where the two packages meet: if the schema changes and a fixture
 * is not updated, this fails rather than the failure surfacing later as a
 * mysterious integration-test error.
 */

const SCHEMA = invoiceJsonSchema();
const CLOCK = fixedClock('2026-07-26T12:00:00.000Z');

async function extract(scenario: string) {
  const result = await extractWithRepair(
    new FixtureLlmExtractor(FIXTURES, scenario),
    CLEAN_INVOICE_TEXT,
    SCHEMA,
  );
  if (!isOk(result)) throw new Error(`Fixture "${scenario}" failed to parse`);
  return result.value;
}

describe('every fixture parses against the real schema', () => {
  const parseable = [
    'clean-invoice',
    'sum-mismatch',
    'missing-vat-number',
    'hallucinated-total',
    'multi-rate',
  ];

  it.each(parseable)('%s', async (scenario) => {
    const { data } = await extract(scenario);
    expect(data.invoiceNumber).toBeTruthy();
  });
});

describe('clean-invoice', () => {
  it('passes every business rule', async () => {
    const { data } = await extract('clean-invoice');
    expect(validateInvoice(data, CLOCK)).toEqual([]);
  });

  it('is fully corroborated by the source text and needs no review', async () => {
    const { data } = await extract('clean-invoice');
    const confidence = assessConfidence(data, { sourceText: CLEAN_INVOICE_TEXT });

    expect(confidence.flaggedPaths).toEqual([]);
    expect(confidence.requiresReview).toBe(false);
  });

  it('would be auto-approved', async () => {
    const { data } = await extract('clean-invoice');
    const findings = validateInvoice(data, CLOCK);
    const confidence = assessConfidence(data, { sourceText: CLEAN_INVOICE_TEXT });

    // COMPLETED requires both: no blocking rule failure and nothing flagged.
    expect(hasBlockingFinding(findings)).toBe(false);
    expect(confidence.requiresReview).toBe(false);
  });
});

describe('sum-mismatch', () => {
  it('actually mismatches — the fixture earns its name', async () => {
    const { data } = await extract('sum-mismatch');
    const findings = validateInvoice(data, CLOCK);

    expect(findings.map((f) => f.rule)).toContain('LINE_ITEMS_SUM');
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it('produces a finding a reviewer can act on', async () => {
    const { data } = await extract('sum-mismatch');
    const finding = validateInvoice(data, CLOCK).find((f) => f.rule === 'LINE_ITEMS_SUM');

    // The demo depends on this reading as a sentence, not a code.
    expect(finding!.message).toMatch(/1240\.00 EUR/);
    expect(finding!.message).toMatch(/1250\.00 EUR/);
  });
});

describe('hallucinated-total', () => {
  it('passes the schema and is caught only by corroboration', async () => {
    const { data } = await extract('hallucinated-total');

    // Schema-valid and confidently reported — nothing about the response
    // itself betrays the problem.
    expect(data.totalCents).toBe(189_900);
    expect(data.fieldConfidence['totalCents']).toBe(0.99);

    const confidence = assessConfidence(data, { sourceText: CLEAN_INVOICE_TEXT });
    expect(confidence.flaggedPaths).toContain('totalCents');
    expect(confidence.fields['totalCents']!.reason).toMatch(/does not appear/);
  });
});

describe('missing-vat-number', () => {
  it('treats an absent optional field as acceptable', async () => {
    const { data } = await extract('missing-vat-number');
    expect(data.vendor.vatNumber).toBeNull();

    // A genuinely absent VAT id must not block: plenty of real invoices lack one.
    const findings = validateInvoice(data, CLOCK);
    expect(findings.map((f) => f.rule)).not.toContain('VAT_ID_FORMAT');
  });
});

describe('multi-rate', () => {
  it('satisfies per-rate VAT arithmetic', async () => {
    const { data } = await extract('multi-rate');
    const findings = validateInvoice(data, CLOCK);

    // 22% of 1000 + 10% of 500 = 270. A single blended rate would fail here.
    expect(findings.map((f) => f.rule)).not.toContain('VAT_ARITHMETIC');
  });
});

describe('cost accounting', () => {
  it('reports zero spend for fixtures', async () => {
    const { usage, model } = await extract('clean-invoice');
    expect(computeCostUsd(usage, model)).toBe(0);
  });

  it('computes a realistic cost for the real model', async () => {
    const { usage } = await extract('clean-invoice');
    const cost = computeCostUsd(usage, 'claude-haiku-4-5-20251001');

    // 1412 in + 402 out at $1/$5 per million ≈ $0.0034 — the number that makes
    // "under $2/month" checkable rather than aspirational.
    expect(cost).toBeCloseTo(0.003422, 6);
  });
});

describe('the generated JSON Schema', () => {
  it('describes an object with the fields the model must return', () => {
    const schema = invoiceJsonSchema();
    expect(schema['type']).toBe('object');

    const properties = schema['properties'] as Record<string, unknown>;
    for (const field of [
      'vendor',
      'invoiceNumber',
      'issueDate',
      'dueDate',
      'currency',
      'lineItems',
      'subtotalCents',
      'vatTotalCents',
      'totalCents',
      'fieldConfidence',
    ]) {
      expect(properties).toHaveProperty(field);
    }
  });

  it('marks nullable fields as nullable rather than omitting them', () => {
    // The distinction the schema design rests on: the model must say "absent",
    // not stay silent.
    const schema = invoiceJsonSchema();
    const required = schema['required'] as string[];
    expect(required).toContain('dueDate');
  });

  it('is inlined, with no $ref for a provider to ignore', () => {
    expect(JSON.stringify(invoiceJsonSchema())).not.toContain('$ref');
  });
});
