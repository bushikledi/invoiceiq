import type { FixtureLibrary } from '../adapters/fixture-extractor.js';

/**
 * Recorded LLM responses, one scenario per interesting failure mode.
 *
 * These are hand-authored right now because there is no API key in this
 * environment. `pnpm record:fixtures` overwrites them with genuine recorded
 * output the moment ANTHROPIC_API_KEY exists — the shapes here were written to
 * match what the Anthropic tool-use API actually returns, so that swap changes
 * the values, not the structure. The README documents the refresh procedure.
 *
 * Each scenario is chosen to exercise a specific path through the pipeline:
 *
 *   clean-invoice          happy path, everything corroborates → COMPLETED
 *   sum-mismatch           lines do not sum to subtotal → NEEDS_REVIEW
 *   missing-vat-number     nullable field genuinely absent → still COMPLETED
 *   hallucinated-total     high self-report, value absent from PDF → flagged
 *   malformed-then-valid   drives the corrective retry loop (attempts = 2)
 *   always-malformed       exhausts retries → FAILED
 *   multi-rate             two VAT rates, exercises per-rate arithmetic
 *   rate-limited           provider 429 → retriable error, no schema attempts
 */

const CLEAN_INVOICE = {
  vendor: {
    name: 'ACME S.r.l.',
    vatNumber: 'IT12345678901',
    address: 'Via Roma 1, 20121 Milano MI',
  },
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
    {
      description: 'Scrivania regolabile in altezza',
      quantity: 1,
      unitPriceCents: 26_000,
      vatRatePercent: 22,
      totalCents: 26_000,
    },
  ],
  subtotalCents: 124_000,
  vatTotalCents: 27_280,
  totalCents: 151_280,
  fieldConfidence: {
    'vendor.name': 0.98,
    'vendor.vatNumber': 0.96,
    'vendor.address': 0.94,
    invoiceNumber: 0.99,
    issueDate: 0.97,
    dueDate: 0.95,
    subtotalCents: 0.98,
    vatTotalCents: 0.97,
    totalCents: 0.99,
    'lineItems[0].totalCents': 0.96,
    'lineItems[0].description': 0.93,
    'lineItems[1].totalCents': 0.96,
    'lineItems[1].description': 0.92,
  },
};

/** Lines total 124000 but the subtotal claims 125000 — the demo scenario. */
const SUM_MISMATCH = {
  ...CLEAN_INVOICE,
  invoiceNumber: 'INV-241',
  subtotalCents: 125_000,
  vatTotalCents: 27_500,
  totalCents: 152_500,
};

const MISSING_VAT_NUMBER = {
  ...CLEAN_INVOICE,
  invoiceNumber: 'INV-255',
  vendor: { name: 'Bright Supplies Ltd', vatNumber: null, address: '14 King Street, London' },
  currency: 'GBP',
  fieldConfidence: { ...CLEAN_INVOICE.fieldConfidence, 'vendor.vatNumber': 0.2 },
};

/** A total that appears nowhere in the source text, reported with confidence. */
const HALLUCINATED_TOTAL = {
  ...CLEAN_INVOICE,
  invoiceNumber: 'INV-262',
  totalCents: 189_900,
  fieldConfidence: { ...CLEAN_INVOICE.fieldConfidence, totalCents: 0.99 },
};

/** €1000 at 22% and €500 at 10% → VAT €270.00, total €1770.00 */
const MULTI_RATE = {
  ...CLEAN_INVOICE,
  invoiceNumber: 'INV-270',
  lineItems: [
    {
      description: 'Consulenza tecnica',
      quantity: 10,
      unitPriceCents: 10_000,
      vatRatePercent: 22,
      totalCents: 100_000,
    },
    {
      description: 'Materiale didattico',
      quantity: 1,
      unitPriceCents: 50_000,
      vatRatePercent: 10,
      totalCents: 50_000,
    },
  ],
  subtotalCents: 150_000,
  vatTotalCents: 27_000,
  totalCents: 177_000,
};

/**
 * A schema-invalid reply.
 *
 * Fractional cents and a string where a number belongs — the two mistakes a
 * model actually makes on money fields, rather than something artificial.
 */
const MALFORMED = {
  ...CLEAN_INVOICE,
  lineItems: [
    {
      description: 'Sedie ufficio ergonomiche',
      quantity: 4,
      unitPriceCents: 24_500,
      vatRatePercent: 22,
      totalCents: 980.5,
    },
  ],
  subtotalCents: '124000',
  totalCents: 151_280,
};

export const FIXTURES: FixtureLibrary = {
  'clean-invoice': {
    responses: [CLEAN_INVOICE],
    usage: { inputTokens: 1_412, outputTokens: 402 },
  },
  'sum-mismatch': {
    responses: [SUM_MISMATCH],
    usage: { inputTokens: 1_388, outputTokens: 398 },
  },
  'missing-vat-number': {
    responses: [MISSING_VAT_NUMBER],
    usage: { inputTokens: 1_204, outputTokens: 371 },
  },
  'hallucinated-total': {
    responses: [HALLUCINATED_TOTAL],
    usage: { inputTokens: 1_401, outputTokens: 405 },
  },
  'multi-rate': {
    responses: [MULTI_RATE],
    usage: { inputTokens: 1_522, outputTokens: 430 },
  },
  'malformed-then-valid': {
    // First call fails the schema; the corrective feedback fixes it.
    responses: [MALFORMED, CLEAN_INVOICE],
    usage: { inputTokens: 1_412, outputTokens: 402 },
  },
  'always-malformed': {
    responses: [MALFORMED, MALFORMED, MALFORMED],
    usage: { inputTokens: 1_412, outputTokens: 402 },
  },
  'rate-limited': {
    responses: [],
    error: { message: '429 Too Many Requests', retriable: true },
  },
  'invalid-request': {
    responses: [],
    error: { message: '400 Invalid request', retriable: false },
  },
};

export type FixtureScenarioName = keyof typeof FIXTURES;

/** Source text matching `clean-invoice`, for corroboration in tests. */
export const CLEAN_INVOICE_TEXT = `
ACME S.r.l.
Via Roma 1, 20121 Milano MI
P.IVA IT12345678901

Fattura n. INV-233
Data: 12/03/2026
Scadenza: 11/04/2026

Sedie ufficio ergonomiche      4 x 245,00     980,00
Scrivania regolabile in altezza 1 x 260,00    260,00

Imponibile                                  1.240,00
IVA 22%                                       272,80
TOTALE                                    € 1.512,80
`;
