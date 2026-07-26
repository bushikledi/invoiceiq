import { describe, expect, it } from 'vitest';
import { fixedClock } from '../shared/clock.js';
import {
  EARLIEST_PLAUSIBLE_YEAR,
  checkCurrencyKnown,
  checkDateSanity,
  checkLineItemMath,
  checkLineItemsSum,
  checkVatArithmetic,
  checkVatIdFormat,
  hasBlockingFinding,
  validateInvoice,
  type Finding,
} from './business-rules.js';
import type { InvoiceExtraction, LineItem } from './invoice-schema.js';

const NOW = fixedClock('2026-07-26T12:00:00.000Z');

const lineItem = (overrides: Partial<LineItem> = {}): LineItem => ({
  description: 'Office chair',
  quantity: 2,
  unitPriceCents: 10_000,
  vatRatePercent: 22,
  totalCents: 20_000,
  ...overrides,
});

/**
 * A clean, internally consistent invoice.
 *   2 × €100.00 = €200.00 subtotal
 *   22% VAT     = €44.00
 *   total       = €244.00
 */
const invoice = (overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction => ({
  vendor: { name: 'ACME S.r.l.', vatNumber: 'IT12345678901', address: 'Via Roma 1, Milano' },
  invoiceNumber: 'INV-233',
  issueDate: '2026-03-12',
  dueDate: '2026-04-11',
  currency: 'EUR',
  lineItems: [lineItem()],
  subtotalCents: 20_000,
  vatTotalCents: 4_400,
  totalCents: 24_400,
  fieldConfidence: {},
  ...overrides,
});

const rules = (findings: Finding[]) => findings.map((f) => f.rule);

describe('a clean invoice', () => {
  it('produces no findings at all', () => {
    expect(validateInvoice(invoice(), NOW)).toEqual([]);
  });

  it('is not blocking', () => {
    expect(hasBlockingFinding(validateInvoice(invoice(), NOW))).toBe(false);
  });
});

describe('LINE_ITEM_MATH', () => {
  it('passes when quantity × unit price equals the line total', () => {
    expect(checkLineItemMath(invoice())).toEqual([]);
  });

  it('fails when the line total disagrees', () => {
    const findings = checkLineItemMath(invoice({ lineItems: [lineItem({ totalCents: 25_000 })] }));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('ERROR');
    expect(findings[0]!.fieldPath).toBe('lineItems[0].totalCents');
    // The message must give a reviewer the actual numbers, not just "mismatch".
    expect(findings[0]!.message).toContain('200.00 EUR');
    expect(findings[0]!.message).toContain('250.00 EUR');
  });

  it('tolerates a one-cent rounding difference', () => {
    expect(checkLineItemMath(invoice({ lineItems: [lineItem({ totalCents: 20_001 })] }))).toEqual(
      [],
    );
    expect(checkLineItemMath(invoice({ lineItems: [lineItem({ totalCents: 19_999 })] }))).toEqual(
      [],
    );
  });

  it('rejects a two-cent difference', () => {
    expect(
      checkLineItemMath(invoice({ lineItems: [lineItem({ totalCents: 20_002 })] })),
    ).toHaveLength(1);
  });

  it('handles fractional quantities', () => {
    // 2.5 × €33.33 = €83.325 → €83.33
    const findings = checkLineItemMath(
      invoice({
        lineItems: [lineItem({ quantity: 2.5, unitPriceCents: 3_333, totalCents: 8_333 })],
      }),
    );
    expect(findings).toEqual([]);
  });

  it('reports each bad line separately with its own index', () => {
    const findings = checkLineItemMath(
      invoice({
        lineItems: [
          lineItem({ totalCents: 20_000 }),
          lineItem({ description: 'Desk', totalCents: 99_999 }),
          lineItem({ description: 'Lamp', totalCents: 1 }),
        ],
      }),
    );

    expect(findings).toHaveLength(2);
    expect(findings[0]!.fieldPath).toBe('lineItems[1].totalCents');
    expect(findings[1]!.fieldPath).toBe('lineItems[2].totalCents');
    expect(findings[0]!.message).toContain('Desk');
  });
});

describe('LINE_ITEMS_SUM', () => {
  it('passes when the lines sum to the subtotal', () => {
    expect(checkLineItemsSum(invoice())).toEqual([]);
  });

  it('fails on the classic sum mismatch', () => {
    // The demo scenario: lines total €1,240.00, subtotal claims €1,250.00.
    const findings = checkLineItemsSum(
      invoice({
        lineItems: [lineItem({ quantity: 1, unitPriceCents: 124_000, totalCents: 124_000 })],
        subtotalCents: 125_000,
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('ERROR');
    expect(findings[0]!.message).toContain('1240.00 EUR');
    expect(findings[0]!.message).toContain('1250.00 EUR');
    expect(findings[0]!.message).toContain('10.00 EUR');
  });

  it('scales tolerance with the number of lines', () => {
    // Ten lines may each carry a cent of vendor-side rounding, so a ten-cent
    // aggregate difference is still acceptable.
    const items = Array.from({ length: 10 }, () =>
      lineItem({ quantity: 1, unitPriceCents: 1_000, totalCents: 1_000 }),
    );
    expect(checkLineItemsSum(invoice({ lineItems: items, subtotalCents: 10_010 }))).toEqual([]);
    expect(checkLineItemsSum(invoice({ lineItems: items, subtotalCents: 10_011 }))).toHaveLength(1);
  });

  it('sums many lines without floating-point drift', () => {
    // 100 lines of €0.01 must be exactly €1.00.
    const items = Array.from({ length: 100 }, () =>
      lineItem({ quantity: 1, unitPriceCents: 1, totalCents: 1 }),
    );
    expect(checkLineItemsSum(invoice({ lineItems: items, subtotalCents: 100 }))).toEqual([]);
  });
});

describe('VAT_ARITHMETIC', () => {
  it('passes on a consistent single-rate invoice', () => {
    expect(checkVatArithmetic(invoice())).toEqual([]);
  });

  it('fails when subtotal + VAT does not equal the total', () => {
    const findings = checkVatArithmetic(invoice({ totalCents: 25_000 }));
    expect(findings.some((f) => f.fieldPath === 'totalCents')).toBe(true);
    expect(findings[0]!.severity).toBe('ERROR');
  });

  it('fails when the VAT total does not match the line rates', () => {
    // 10% claimed on a 22% invoice.
    const findings = checkVatArithmetic(invoice({ vatTotalCents: 2_000, totalCents: 22_000 }));
    expect(findings.some((f) => f.fieldPath === 'vatTotalCents')).toBe(true);
  });

  it('handles a multi-rate invoice correctly', () => {
    // €100 at 22% = €22.00, €50 at 10% = €5.00 → VAT €27.00, total €177.00
    const findings = checkVatArithmetic(
      invoice({
        lineItems: [
          lineItem({ quantity: 1, unitPriceCents: 10_000, totalCents: 10_000, vatRatePercent: 22 }),
          lineItem({ quantity: 1, unitPriceCents: 5_000, totalCents: 5_000, vatRatePercent: 10 }),
        ],
        subtotalCents: 15_000,
        vatTotalCents: 2_700,
        totalCents: 17_700,
      }),
    );
    expect(findings).toEqual([]);
  });

  it('catches one rate applied to the whole invoice instead of per-rate', () => {
    // 22% applied to all €150 gives €33.00 rather than the correct €27.00.
    const findings = checkVatArithmetic(
      invoice({
        lineItems: [
          lineItem({ quantity: 1, unitPriceCents: 10_000, totalCents: 10_000, vatRatePercent: 22 }),
          lineItem({ quantity: 1, unitPriceCents: 5_000, totalCents: 5_000, vatRatePercent: 10 }),
        ],
        subtotalCents: 15_000,
        vatTotalCents: 3_300,
        totalCents: 18_300,
      }),
    );
    expect(rules(findings)).toContain('VAT_ARITHMETIC');
  });

  it('accepts a zero-rated invoice', () => {
    const findings = checkVatArithmetic(
      invoice({
        lineItems: [lineItem({ vatRatePercent: 0 })],
        vatTotalCents: 0,
        totalCents: 20_000,
      }),
    );
    expect(findings).toEqual([]);
  });

  it('tolerates a one-cent rounding difference on the total', () => {
    expect(checkVatArithmetic(invoice({ totalCents: 24_401 }))).toEqual([]);
    expect(checkVatArithmetic(invoice({ totalCents: 24_402 }))).not.toEqual([]);
  });
});

describe('DATE_SANITY', () => {
  it('passes for ordinary dates', () => {
    expect(checkDateSanity(invoice(), NOW)).toEqual([]);
  });

  it('fails when the issue date is in the future', () => {
    const findings = checkDateSanity(invoice({ issueDate: '2026-09-01' }), NOW);
    expect(findings[0]!.rule).toBe('DATE_SANITY');
    expect(findings[0]!.severity).toBe('ERROR');
  });

  it('allows today', () => {
    expect(checkDateSanity(invoice({ issueDate: '2026-07-26', dueDate: null }), NOW)).toEqual([]);
  });

  it('allows exactly one day ahead, to absorb timezone skew', () => {
    // A vendor a few hours ahead of us legitimately issues an invoice dated
    // "tomorrow" from our point of view.
    expect(checkDateSanity(invoice({ issueDate: '2026-07-27', dueDate: null }), NOW)).toEqual([]);
  });

  it('rejects two days ahead', () => {
    expect(checkDateSanity(invoice({ issueDate: '2026-07-28', dueDate: null }), NOW)).toHaveLength(
      1,
    );
  });

  it('warns rather than errors on an implausibly old date', () => {
    // Probably an OCR misread of the year, not a fraudulent invoice.
    const findings = checkDateSanity(invoice({ issueDate: '1999-01-01', dueDate: null }), NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('WARNING');
    expect(findings[0]!.message).toContain(String(EARLIEST_PLAUSIBLE_YEAR));
  });

  it('accepts the earliest plausible year itself', () => {
    expect(checkDateSanity(invoice({ issueDate: '2000-01-01', dueDate: null }), NOW)).toEqual([]);
  });

  it('fails when the due date precedes the issue date', () => {
    const findings = checkDateSanity(
      invoice({ issueDate: '2026-03-12', dueDate: '2026-03-11' }),
      NOW,
    );
    expect(findings[0]!.fieldPath).toBe('dueDate');
    expect(findings[0]!.severity).toBe('ERROR');
  });

  it('allows a due date equal to the issue date', () => {
    // "Due on receipt" is a real payment term.
    expect(
      checkDateSanity(invoice({ issueDate: '2026-03-12', dueDate: '2026-03-12' }), NOW),
    ).toEqual([]);
  });

  it('ignores a null due date', () => {
    expect(checkDateSanity(invoice({ dueDate: null }), NOW)).toEqual([]);
  });

  it('handles a leap day', () => {
    expect(
      checkDateSanity(invoice({ issueDate: '2024-02-29', dueDate: '2024-03-01' }), NOW),
    ).toEqual([]);
  });

  it('does not depend on the machine timezone', () => {
    // Comparison happens in UTC. An invoice dated today must pass whether the
    // server sits in Auckland or Los Angeles.
    const lateUtc = fixedClock('2026-07-26T23:59:59.000Z');
    const earlyUtc = fixedClock('2026-07-26T00:00:01.000Z');
    expect(checkDateSanity(invoice({ issueDate: '2026-07-26', dueDate: null }), lateUtc)).toEqual(
      [],
    );
    expect(checkDateSanity(invoice({ issueDate: '2026-07-26', dueDate: null }), earlyUtc)).toEqual(
      [],
    );
  });
});

describe('VAT_ID_FORMAT', () => {
  it('accepts a well-formed Italian VAT number', () => {
    expect(checkVatIdFormat(invoice())).toEqual([]);
  });

  it('warns on a malformed one', () => {
    const findings = checkVatIdFormat(
      invoice({ vendor: { name: 'ACME', vatNumber: 'IT123', address: null } }),
    );
    expect(findings).toHaveLength(1);
    // A warning, not an error: format is a heuristic, and only VIES can say
    // whether a VAT id is real.
    expect(findings[0]!.severity).toBe('WARNING');
  });

  it('ignores an absent VAT number', () => {
    expect(
      checkVatIdFormat(invoice({ vendor: { name: 'ACME', vatNumber: null, address: null } })),
    ).toEqual([]);
  });

  it('ignores an empty string', () => {
    expect(
      checkVatIdFormat(invoice({ vendor: { name: 'ACME', vatNumber: '   ', address: null } })),
    ).toEqual([]);
  });

  it('normalises spaces, dots and dashes before matching', () => {
    // Invoices print VAT ids every possible way; punctuation is not an error.
    expect(
      checkVatIdFormat(
        invoice({ vendor: { name: 'ACME', vatNumber: 'IT 123.456-78901', address: null } }),
      ),
    ).toEqual([]);
  });

  it('stays silent for a country we have no pattern for', () => {
    // No pattern means no opinion — not a warning.
    expect(
      checkVatIdFormat(invoice({ vendor: { name: 'X', vatNumber: 'ZZ999999', address: null } })),
    ).toEqual([]);
  });

  it.each([
    ['DE123456789', true],
    ['DE12345', false],
    ['NL123456789B01', true],
    ['ATU12345678', true],
    ['BE0123456789', true],
    ['PL1234567890', true],
  ])('validates %s', (vatNumber, valid) => {
    const findings = checkVatIdFormat(invoice({ vendor: { name: 'X', vatNumber, address: null } }));
    expect(findings.length === 0).toBe(valid);
  });
});

describe('CURRENCY_KNOWN', () => {
  it('accepts EUR', () => {
    expect(checkCurrencyKnown(invoice())).toEqual([]);
  });

  it.each(['USD', 'GBP', 'CHF', 'JPY'])('accepts %s', (currency) => {
    expect(checkCurrencyKnown(invoice({ currency }))).toEqual([]);
  });

  it('warns on an unrecognised code', () => {
    const findings = checkCurrencyKnown(invoice({ currency: 'XYZ' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('WARNING');
  });
});

describe('validateInvoice', () => {
  it('collects findings from every rule', () => {
    const findings = validateInvoice(
      invoice({
        lineItems: [lineItem({ totalCents: 30_000 })],
        subtotalCents: 20_000,
        currency: 'XYZ',
        vendor: { name: 'ACME', vatNumber: 'IT999', address: null },
      }),
      NOW,
    );

    expect(rules(findings)).toEqual(
      expect.arrayContaining(['LINE_ITEM_MATH', 'VAT_ID_FORMAT', 'CURRENCY_KNOWN']),
    );
  });

  it('reports blocking when any ERROR is present', () => {
    const findings = validateInvoice(invoice({ totalCents: 99_999 }), NOW);
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it('does not report blocking for warnings alone', () => {
    // A strange currency should route to review only via confidence, not force
    // a hard block on its own.
    const findings = validateInvoice(invoice({ currency: 'XYZ' }), NOW);
    expect(findings.every((f) => f.severity === 'WARNING')).toBe(true);
    expect(hasBlockingFinding(findings)).toBe(false);
  });

  it('is deterministic', () => {
    const target = invoice({ totalCents: 12_345 });
    expect(validateInvoice(target, NOW)).toEqual(validateInvoice(target, NOW));
  });
});
