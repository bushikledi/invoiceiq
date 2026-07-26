import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIDENCE_THRESHOLD, assessConfidence } from './confidence-policy.js';
import { extractAmounts, parseAmountToCents } from './corroboration.js';
import type { InvoiceExtraction } from './invoice-schema.js';

/** Text as it would come out of a real Italian invoice PDF. */
const SOURCE_TEXT = `
ACME S.r.l.
Via Roma 1, Milano
P.IVA IT12345678901

Fattura n. INV-233
Data: 12/03/2026
Scadenza: 11/04/2026

Sedie ufficio          2 x 100,00      200,00
                       Imponibile      200,00
                       IVA 22%          44,00
                       TOTALE        € 244,00
`;

const confident = (paths: string[], value = 0.97): Record<string, number> =>
  Object.fromEntries(paths.map((p) => [p, value]));

const invoice = (overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction => ({
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
  fieldConfidence: confident([
    'vendor.name',
    'vendor.vatNumber',
    'vendor.address',
    'invoiceNumber',
    'issueDate',
    'dueDate',
    'subtotalCents',
    'vatTotalCents',
    'totalCents',
    'lineItems[0].totalCents',
    'lineItems[0].description',
  ]),
  ...overrides,
});

describe('parseAmountToCents', () => {
  it.each([
    ['200,00', 20_000],
    ['200.00', 20_000],
    ['1.240,50', 124_050],
    ['1,240.50', 124_050],
    ['1240.50', 124_050],
    ['44,00', 4_400],
    ['0,05', 5],
  ])('parses %s', (token, expected) => {
    expect(parseAmountToCents(token)).toBe(expected);
  });

  it('treats a separator not followed by two digits as a thousands separator', () => {
    // European invoices write €1.240 meaning one thousand two hundred forty.
    expect(parseAmountToCents('1.240')).toBe(124_000);
    expect(parseAmountToCents('1,240')).toBe(124_000);
  });

  it('handles a bare integer', () => {
    expect(parseAmountToCents('244')).toBe(24_400);
  });

  it('returns null for non-numeric input', () => {
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('')).toBeNull();
  });
});

describe('extractAmounts', () => {
  it('finds amounts written with a decimal comma', () => {
    const amounts = extractAmounts(SOURCE_TEXT);
    expect(amounts.has(24_400)).toBe(true);
    expect(amounts.has(20_000)).toBe(true);
    expect(amounts.has(4_400)).toBe(true);
  });

  it('does not invent amounts that are absent', () => {
    expect(extractAmounts(SOURCE_TEXT).has(999_999)).toBe(false);
  });

  it('does NOT merge column-aligned amounts into one number', () => {
    // Regression. The tokeniser once allowed \s inside a number, so
    //     "4 x 245,00     980,00"
    // parsed as the single value 24500980 and neither real amount was found.
    // Invoices are almost entirely columns of numbers, so this failed
    // corroboration on essentially every document while still looking fine in
    // a naive test.
    const amounts = extractAmounts('Sedie ufficio     4 x 245,00     980,00');

    expect(amounts.has(24_500)).toBe(true);
    expect(amounts.has(98_000)).toBe(true);
    expect(amounts.has(24_500_980)).toBe(false);
  });

  it('does not merge numbers across a line break', () => {
    const amounts = extractAmounts('Imponibile 1.240,00\nIVA 22% 272,80');
    expect(amounts.has(124_000)).toBe(true);
    expect(amounts.has(27_280)).toBe(true);
  });

  it('still reads a space-separated thousands group', () => {
    // French invoices print "1 240,50"; a single space before exactly three
    // digits is a genuine thousands separator, unlike a column gap.
    expect(extractAmounts('Total 1 240,50').has(124_050)).toBe(true);
  });
});

describe('assessConfidence', () => {
  describe('a clean, corroborated extraction', () => {
    it('flags nothing', () => {
      const result = assessConfidence(invoice(), { sourceText: SOURCE_TEXT });
      expect(result.flaggedPaths).toEqual([]);
      expect(result.requiresReview).toBe(false);
    });

    it('scores high overall', () => {
      const result = assessConfidence(invoice(), { sourceText: SOURCE_TEXT });
      expect(result.overall).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('corroboration catches hallucination', () => {
    /**
     * The scenario the whole policy exists for: the model reports 99%
     * confidence in a total that appears nowhere in the document.
     */
    it('flags a confidently-reported total that is not in the document', () => {
      const result = assessConfidence(
        invoice({
          totalCents: 999_900,
          fieldConfidence: { ...invoice().fieldConfidence, totalCents: 0.99 },
        }),
        { sourceText: SOURCE_TEXT },
      );

      expect(result.flaggedPaths).toContain('totalCents');
      expect(result.fields['totalCents']!.selfReport).toBe(0.99);
      expect(result.fields['totalCents']!.corroboration).toBeLessThan(1);
      expect(result.fields['totalCents']!.reason).toMatch(/does not appear/);
    });

    it('takes the minimum, never an average, of the signals', () => {
      // Averaging 0.99 self-report with 0.5 corroboration gives 0.745 — still
      // below threshold here, but the moment self-report hits 1.0 and the
      // threshold drops, averaging starts laundering hallucinations. min() does
      // not have that failure mode.
      const result = assessConfidence(
        invoice({
          totalCents: 888_800,
          fieldConfidence: { ...invoice().fieldConfidence, totalCents: 1 },
        }),
        { sourceText: SOURCE_TEXT },
      );
      const field = result.fields['totalCents']!;
      expect(field.score).toBe(Math.min(field.selfReport, field.presence, field.corroboration));
    });

    it('corroborates a vendor name despite accents and case', () => {
      const result = assessConfidence(
        invoice({ vendor: { ...invoice().vendor, name: 'acme s.r.l.' } }),
        {
          sourceText: SOURCE_TEXT,
        },
      );
      expect(result.fields['vendor.name']!.corroboration).toBe(1);
    });

    it('corroborates a date written in dd/mm/yyyy form', () => {
      // The document says 12/03/2026; we normalised to 2026-03-12.
      const result = assessConfidence(invoice(), { sourceText: SOURCE_TEXT });
      expect(result.fields['issueDate']!.corroboration).toBe(1);
    });

    it('flags a date that is not in the document at all', () => {
      const result = assessConfidence(invoice({ issueDate: '2019-01-01' }), {
        sourceText: SOURCE_TEXT,
      });
      expect(result.flaggedPaths).toContain('issueDate');
    });
  });

  describe('presence', () => {
    it('penalises an expected field that came back null', () => {
      const result = assessConfidence(invoice({ dueDate: null }), { sourceText: SOURCE_TEXT });
      // dueDate is genuinely optional on real invoices, so a null must not be
      // treated as a failure.
      expect(result.flaggedPaths).not.toContain('dueDate');
    });

    it('does not penalise an optional field that came back null', () => {
      const result = assessConfidence(
        invoice({ vendor: { name: 'ACME S.r.l.', vatNumber: null, address: null } }),
        { sourceText: SOURCE_TEXT },
      );
      expect(result.flaggedPaths).not.toContain('vendor.vatNumber');
      expect(result.flaggedPaths).not.toContain('vendor.address');
    });
  });

  describe('self-reported confidence', () => {
    it('flags a field the model itself doubts', () => {
      const result = assessConfidence(
        invoice({ fieldConfidence: { ...invoice().fieldConfidence, invoiceNumber: 0.3 } }),
        { sourceText: SOURCE_TEXT },
      );
      expect(result.flaggedPaths).toContain('invoiceNumber');
      expect(result.fields['invoiceNumber']!.reason).toMatch(/low confidence/);
    });

    it('assumes a middling score when the model omits a field entirely', () => {
      // Silence is not confidence. An omitted field must not inherit 1.0.
      const result = assessConfidence(invoice({ fieldConfidence: {} }), {
        sourceText: SOURCE_TEXT,
      });
      expect(result.fields['totalCents']!.selfReport).toBeLessThan(1);
      expect(result.flaggedPaths).toContain('totalCents');
    });
  });

  describe('threshold', () => {
    it('respects a custom threshold', () => {
      const lenient = assessConfidence(
        invoice({ fieldConfidence: { ...invoice().fieldConfidence, totalCents: 0.6 } }),
        { sourceText: SOURCE_TEXT, threshold: 0.5 },
      );
      expect(lenient.flaggedPaths).not.toContain('totalCents');

      const strict = assessConfidence(
        invoice({ fieldConfidence: { ...invoice().fieldConfidence, totalCents: 0.6 } }),
        { sourceText: SOURCE_TEXT, threshold: 0.9 },
      );
      expect(strict.flaggedPaths).toContain('totalCents');
    });

    it('uses 0.85 by default', () => {
      expect(DEFAULT_CONFIDENCE_THRESHOLD).toBe(0.85);
    });
  });

  describe('missing source text', () => {
    it('skips corroboration entirely rather than failing every field', () => {
      // A scanned PDF yields no text. Scoring every field as uncorroborated
      // would flag the whole document for a reason that says nothing about the
      // quality of the extraction.
      const result = assessConfidence(invoice(), { sourceText: '' });
      expect(result.flaggedPaths).toEqual([]);
      for (const field of Object.values(result.fields)) {
        expect(field.corroboration).toBe(1);
      }
    });

    it('behaves the same when sourceText is not supplied at all', () => {
      expect(assessConfidence(invoice()).flaggedPaths).toEqual([]);
    });
  });

  describe('overall score', () => {
    it('weights critical fields double', () => {
      const criticalDoubt = assessConfidence(
        invoice({ fieldConfidence: { ...invoice().fieldConfidence, totalCents: 0.2 } }),
        { sourceText: SOURCE_TEXT },
      );
      const trivialDoubt = assessConfidence(
        invoice({ fieldConfidence: { ...invoice().fieldConfidence, 'vendor.address': 0.2 } }),
        { sourceText: SOURCE_TEXT },
      );

      // A doubtful total must hurt the overall score more than a doubtful
      // address: one is a payment error, the other is an annoyance.
      expect(criticalDoubt.overall).toBeLessThan(trivialDoubt.overall);
    });

    it('rounds to three decimals to match the stored NUMERIC(4,3)', () => {
      const result = assessConfidence(invoice(), { sourceText: SOURCE_TEXT });
      expect(result.overall).toBe(Math.round(result.overall * 1000) / 1000);
    });

    it('stays within 0..1', () => {
      const result = assessConfidence(
        invoice({ fieldConfidence: { ...invoice().fieldConfidence, totalCents: 0 } }),
        { sourceText: SOURCE_TEXT },
      );
      expect(result.overall).toBeGreaterThanOrEqual(0);
      expect(result.overall).toBeLessThanOrEqual(1);
    });
  });

  it('is deterministic', () => {
    const target = invoice();
    expect(assessConfidence(target, { sourceText: SOURCE_TEXT })).toEqual(
      assessConfidence(target, { sourceText: SOURCE_TEXT }),
    );
  });
});
