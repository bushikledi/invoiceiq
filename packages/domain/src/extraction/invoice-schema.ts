import { z } from 'zod';

/**
 * The invoice extraction schema — the single source of truth for the whole
 * system.
 *
 * The JSON Schema sent to the LLM is generated from this object, the worker
 * validates the model's reply against it, the API serves it, and the frontend
 * derives its types from it. There is exactly one definition, so the prompt and
 * the validator cannot drift apart.
 *
 * Two choices here are worth defending:
 *
 * 1. `.nullable()` everywhere, never `.optional()`. An optional field lets the
 *    model quietly omit something it could not find, which is indistinguishable
 *    from it forgetting. Nullable forces an explicit "this is absent" decision,
 *    and a null we can reason about — the confidence policy scores it, and a
 *    reviewer sees an empty field rather than a missing one.
 *
 * 2. Money as integer minor units plus a currency code, never a decimal. See
 *    the Money value object for why floats and invoices do not mix.
 */

/** Minor units. Integer by construction; the Money VO does the arithmetic. */
export const MoneyCentsSchema = z
  .number()
  .int('Monetary amounts must be integer minor units (cents), not decimals');

/** ISO-8601 calendar date, no time component. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Date must be a real calendar date')
  .refine((value) => {
    // Date.parse accepts 2026-02-30 and silently rolls it to March 2nd, which
    // would let an impossible date through as valid.
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, 'Date must be a real calendar date');

export const LineItemSchema = z.object({
  description: z.string().min(1, 'Line item description cannot be empty'),
  quantity: z.number().positive('Quantity must be greater than zero'),
  unitPriceCents: MoneyCentsSchema,
  vatRatePercent: z.number().min(0).max(100),
  totalCents: MoneyCentsSchema,
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const VendorSchema = z.object({
  name: z.string().min(1, 'Vendor name cannot be empty'),
  /** Nullable, not optional — the model must say whether it found one. */
  vatNumber: z.string().nullable(),
  address: z.string().nullable(),
});
export type Vendor = z.infer<typeof VendorSchema>;

export const InvoiceExtractionSchema = z.object({
  vendor: VendorSchema,
  invoiceNumber: z.string().min(1, 'Invoice number cannot be empty'),
  issueDate: IsoDateSchema,
  dueDate: IsoDateSchema.nullable(),
  currency: z
    .string()
    .length(3, 'Currency must be a three-letter ISO-4217 code')
    .transform((value) => value.toUpperCase()),
  lineItems: z.array(LineItemSchema).min(1, 'An invoice must have at least one line item'),
  subtotalCents: MoneyCentsSchema,
  vatTotalCents: MoneyCentsSchema,
  totalCents: MoneyCentsSchema,
  /**
   * The model's own confidence per field path, 0..1.
   *
   * One signal among several, never the only one — self-reported LLM confidence
   * is poorly calibrated and a hallucinated total is often reported with
   * complete assurance. See the confidence policy.
   */
  fieldConfidence: z.record(z.string(), z.number().min(0).max(1)),
});

export type InvoiceExtraction = z.infer<typeof InvoiceExtractionSchema>;

/**
 * Field paths the confidence policy treats as load-bearing.
 *
 * Totals and VAT carry double weight in the overall score because they are
 * what an approver is actually accountable for; a wrong address is an
 * annoyance, a wrong total is a payment error.
 */
export const CRITICAL_FIELD_PATHS = [
  'totalCents',
  'vatTotalCents',
  'subtotalCents',
  'invoiceNumber',
] as const;

/** Fields we expect on essentially every real invoice. */
export const EXPECTED_FIELD_PATHS = [
  'vendor.name',
  'invoiceNumber',
  'issueDate',
  'currency',
  'subtotalCents',
  'vatTotalCents',
  'totalCents',
] as const;
