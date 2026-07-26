import type { Clock } from '../shared/clock.js';
import { Money } from '../shared/money.js';
import type { InvoiceExtraction, LineItem } from './invoice-schema.js';

/**
 * Business rules — the arithmetic and sanity checks a competent human would
 * run before approving an invoice.
 *
 * These exist because schema validity is not correctness. An LLM will happily
 * return a perfectly-shaped invoice whose line items sum to €1,240 while the
 * stated total is €1,250. The schema cannot catch that; arithmetic can, and
 * deterministically, at zero token cost.
 *
 * Every rule is a pure function of (extraction, clock) → Finding[]. No I/O, no
 * wall clock, no framework. That is what makes them exhaustively testable —
 * and they are the layer everything else trusts, so they are tested hardest.
 */

export type FindingSeverity = 'ERROR' | 'WARNING';

export type RuleName =
  | 'LINE_ITEM_MATH'
  | 'LINE_ITEMS_SUM'
  | 'VAT_ARITHMETIC'
  | 'DATE_SANITY'
  | 'VAT_ID_FORMAT'
  | 'CURRENCY_KNOWN';

export interface Finding {
  readonly rule: RuleName;
  readonly severity: FindingSeverity;
  /** Dotted/indexed path to the offending field, e.g. `lineItems[2].totalCents`. */
  readonly fieldPath: string | null;
  /** Written for a reviewer, with concrete amounts — never "validation failed". */
  readonly message: string;
}

/**
 * Rounding tolerances.
 *
 * A vendor that rounds each line before summing legitimately differs from a
 * recomputed total by up to a cent per line. Demanding exactness would flag a
 * large share of perfectly correct invoices, and a reviewer facing constant
 * false positives stops reading them — which is worse than not checking.
 */
export const TOLERANCE = {
  /** Per line: quantity × unit price versus the stated line total. */
  LINE_ITEM_CENTS: 1,
  /** Per-line accumulation when summing many lines. */
  PER_LINE_CENTS: 1,
  /** subtotal + VAT versus total. */
  TOTAL_CENTS: 1,
} as const;

/** Dates before this are almost certainly a misread, not a real invoice. */
export const EARLIEST_PLAUSIBLE_YEAR = 2000;

/** ISO-4217 codes we expect to encounter. Anything else warrants a look. */
const KNOWN_CURRENCIES = new Set([
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'RON',
  'JPY',
  'CAD',
  'AUD',
]);

/**
 * EU VAT identifier patterns, by country prefix.
 *
 * Deliberately format-only. A checksum-valid VAT number can still belong to
 * nobody, and real verification means calling VIES — out of scope, and not
 * something to do synchronously inside a validation rule. So this is a
 * WARNING: it catches transposed digits and OCR noise without pretending to
 * prove the vendor exists.
 */
const VAT_PATTERNS: Record<string, RegExp> = {
  IT: /^IT\d{11}$/,
  DE: /^DE\d{9}$/,
  FR: /^FR[0-9A-Z]{2}\d{9}$/,
  ES: /^ES[0-9A-Z]\d{7}[0-9A-Z]$/,
  NL: /^NL\d{9}B\d{2}$/,
  BE: /^BE0\d{9}$/,
  AT: /^ATU\d{8}$/,
  PL: /^PL\d{10}$/,
  IE: /^IE\d{7}[A-Z]{1,2}$/,
  PT: /^PT\d{9}$/,
};

/** Runs every rule and returns all findings, in a stable order. */
export function validateInvoice(extraction: InvoiceExtraction, clock: Clock): Finding[] {
  return [
    ...checkLineItemMath(extraction),
    ...checkLineItemsSum(extraction),
    ...checkVatArithmetic(extraction),
    ...checkDateSanity(extraction, clock),
    ...checkVatIdFormat(extraction),
    ...checkCurrencyKnown(extraction),
  ];
}

/** True when any finding is severe enough to block auto-approval. */
export const hasBlockingFinding = (findings: readonly Finding[]): boolean =>
  findings.some((finding) => finding.severity === 'ERROR');

// ---------------------------------------------------------------- LINE_ITEM_MATH

/** quantity × unitPrice ≈ lineTotal, per line. */
export function checkLineItemMath(extraction: InvoiceExtraction): Finding[] {
  const { currency, lineItems } = extraction;

  return lineItems.flatMap((item: LineItem, index: number) => {
    const expected = Money.of(item.unitPriceCents, currency).times(item.quantity);
    const stated = Money.of(item.totalCents, currency);

    if (expected.withinTolerance(stated, TOLERANCE.LINE_ITEM_CENTS)) return [];

    return [
      {
        rule: 'LINE_ITEM_MATH' as const,
        severity: 'ERROR' as const,
        fieldPath: `lineItems[${index}].totalCents`,
        message:
          `Line ${index + 1} ("${item.description}"): ${item.quantity} × ` +
          `${Money.of(item.unitPriceCents, currency).format()} = ${expected.format()}, ` +
          `but the line total says ${stated.format()}.`,
      },
    ];
  });
}

// ---------------------------------------------------------------- LINE_ITEMS_SUM

/** Σ line totals ≈ subtotal. */
export function checkLineItemsSum(extraction: InvoiceExtraction): Finding[] {
  const { currency, lineItems, subtotalCents } = extraction;

  const summed = Money.sum(
    lineItems.map((item) => Money.of(item.totalCents, currency)),
    currency,
  );
  const stated = Money.of(subtotalCents, currency);

  // Tolerance scales with line count: each line can contribute its own cent of
  // vendor-side rounding.
  const tolerance = Math.max(1, lineItems.length * TOLERANCE.PER_LINE_CENTS);

  if (summed.withinTolerance(stated, tolerance)) return [];

  const difference = stated.minus(summed);
  return [
    {
      rule: 'LINE_ITEMS_SUM',
      severity: 'ERROR',
      fieldPath: 'subtotalCents',
      message:
        `Line items sum to ${summed.format()} but the subtotal says ${stated.format()} ` +
        `(off by ${difference.abs().format()}).`,
    },
  ];
}

// ---------------------------------------------------------------- VAT_ARITHMETIC

/**
 * Two independent checks:
 *   a) subtotal + VAT ≈ total  — the identity that must always hold
 *   b) Σ per-rate VAT ≈ stated VAT total — catches a rate applied to the wrong base
 */
export function checkVatArithmetic(extraction: InvoiceExtraction): Finding[] {
  const { currency, lineItems, subtotalCents, vatTotalCents, totalCents } = extraction;
  const findings: Finding[] = [];

  const subtotal = Money.of(subtotalCents, currency);
  const vat = Money.of(vatTotalCents, currency);
  const total = Money.of(totalCents, currency);

  const expectedTotal = subtotal.plus(vat);
  if (!expectedTotal.withinTolerance(total, TOLERANCE.TOTAL_CENTS)) {
    findings.push({
      rule: 'VAT_ARITHMETIC',
      severity: 'ERROR',
      fieldPath: 'totalCents',
      message:
        `Subtotal ${subtotal.format()} plus VAT ${vat.format()} is ${expectedTotal.format()}, ` +
        `but the total says ${total.format()}.`,
    });
  }

  // Group by rate and apply each rate to its own base, which is how a
  // multi-rate invoice is actually computed.
  const byRate = new Map<number, Money>();
  for (const item of lineItems) {
    const base = byRate.get(item.vatRatePercent) ?? Money.zero(currency);
    byRate.set(item.vatRatePercent, base.plus(Money.of(item.totalCents, currency)));
  }

  const expectedVat = Money.sum(
    [...byRate.entries()].map(([rate, base]) => base.percentage(rate)),
    currency,
  );

  // One cent of slack per distinct rate, plus one overall.
  const vatTolerance = Math.max(1, byRate.size);

  if (!expectedVat.withinTolerance(vat, vatTolerance)) {
    const rates = [...byRate.keys()].sort((a, b) => a - b).join('%, ');
    findings.push({
      rule: 'VAT_ARITHMETIC',
      severity: 'ERROR',
      fieldPath: 'vatTotalCents',
      message:
        `Applying the line item VAT rates (${rates}%) gives ${expectedVat.format()}, ` +
        `but the stated VAT total is ${vat.format()}.`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------- DATE_SANITY

/**
 * Dates must be plausible.
 *
 * `issueDate` may be at most one day in the future — timezone differences
 * between the vendor and our server make a same-day invoice look
 * future-dated, and flagging that would be noise.
 */
export function checkDateSanity(extraction: InvoiceExtraction, clock: Clock): Finding[] {
  const findings: Finding[] = [];
  const { issueDate, dueDate } = extraction;

  const issued = parseIsoDate(issueDate);
  const today = startOfUtcDay(clock.now());
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

  if (issued.getTime() > tomorrow.getTime()) {
    findings.push({
      rule: 'DATE_SANITY',
      severity: 'ERROR',
      fieldPath: 'issueDate',
      message: `Issue date ${issueDate} is in the future.`,
    });
  }

  if (issued.getUTCFullYear() < EARLIEST_PLAUSIBLE_YEAR) {
    findings.push({
      rule: 'DATE_SANITY',
      severity: 'WARNING',
      fieldPath: 'issueDate',
      message: `Issue date ${issueDate} is before ${EARLIEST_PLAUSIBLE_YEAR} and is probably a misread.`,
    });
  }

  if (dueDate !== null) {
    const due = parseIsoDate(dueDate);
    if (due.getTime() < issued.getTime()) {
      findings.push({
        rule: 'DATE_SANITY',
        severity: 'ERROR',
        fieldPath: 'dueDate',
        message: `Due date ${dueDate} falls before the issue date ${issueDate}.`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------- VAT_ID_FORMAT

/** Format check only, and only when a VAT id is present. */
export function checkVatIdFormat(extraction: InvoiceExtraction): Finding[] {
  const vatNumber = extraction.vendor.vatNumber;

  // Absent is not invalid — plenty of legitimate invoices carry no VAT id, and
  // the confidence policy handles missing values separately.
  if (vatNumber === null || vatNumber.trim() === '') return [];

  const normalized = vatNumber.replace(/[\s.-]/g, '').toUpperCase();
  const prefix = normalized.slice(0, 2);
  const pattern = VAT_PATTERNS[prefix];

  // An unrecognised country prefix is not evidence of an error; we simply have
  // no pattern to judge it by.
  if (!pattern) return [];

  if (pattern.test(normalized)) return [];

  return [
    {
      rule: 'VAT_ID_FORMAT',
      severity: 'WARNING',
      fieldPath: 'vendor.vatNumber',
      message: `VAT number "${vatNumber}" does not match the expected ${prefix} format.`,
    },
  ];
}

// ---------------------------------------------------------------- CURRENCY_KNOWN

export function checkCurrencyKnown(extraction: InvoiceExtraction): Finding[] {
  if (KNOWN_CURRENCIES.has(extraction.currency)) return [];

  return [
    {
      rule: 'CURRENCY_KNOWN',
      severity: 'WARNING',
      fieldPath: 'currency',
      message: `Currency "${extraction.currency}" is not one we recognise — please confirm.`,
    },
  ];
}

// ---------------------------------------------------------------- helpers

function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}

/** Compares dates in UTC so the result does not depend on the server's zone. */
function startOfUtcDay(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}
