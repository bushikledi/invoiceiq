import { z } from 'zod';
import { DocumentStatusSchema } from '../documents/document.contracts.js';

/**
 * Review wire format.
 *
 * The detail endpoint returns everything the review screen needs in one call —
 * document, latest extraction, per-field confidence, findings and the event
 * timeline. Four round trips to render one screen would be four chances for a
 * partial render and four separate loading states to design.
 */

export const FindingSeveritySchema = z.enum(['ERROR', 'WARNING']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const ValidationFindingSchema = z.object({
  id: z.string(),
  rule: z.string(),
  severity: FindingSeveritySchema,
  fieldPath: z.string().nullable(),
  message: z.string(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type ValidationFinding = z.infer<typeof ValidationFindingSchema>;

/** Per-field confidence, as computed by the domain policy. */
export const FieldScoreSchema = z.object({
  path: z.string(),
  score: z.number(),
  flagged: z.boolean(),
  selfReport: z.number(),
  presence: z.number(),
  corroboration: z.number(),
  /** Why the field lost points — shown in the reviewer's tooltip. */
  reason: z.string().nullable(),
});
export type FieldScore = z.infer<typeof FieldScoreSchema>;

export const LineItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPriceCents: z.number().int(),
  vatRatePercent: z.number(),
  totalCents: z.number().int(),
});

export const InvoiceDataSchema = z.object({
  vendor: z.object({
    name: z.string(),
    vatNumber: z.string().nullable(),
    address: z.string().nullable(),
  }),
  invoiceNumber: z.string(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  currency: z.string(),
  lineItems: z.array(LineItemSchema),
  subtotalCents: z.number().int(),
  vatTotalCents: z.number().int(),
  totalCents: z.number().int(),
  fieldConfidence: z.record(z.string(), z.number()),
});
export type InvoiceData = z.infer<typeof InvoiceDataSchema>;

export const ExtractionDetailSchema = z.object({
  id: z.uuid(),
  version: z.int(),
  data: InvoiceDataSchema,
  fieldMeta: z.record(z.string(), FieldScoreSchema),
  overallConfidence: z.number(),
  model: z.string(),
  promptVersion: z.string(),
  attempts: z.int(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  costUsd: z.number(),
  createdAt: z.iso.datetime(),
  findings: z.array(ValidationFindingSchema),
});
export type ExtractionDetail = z.infer<typeof ExtractionDetailSchema>;

export const DocumentEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type DocumentEvent = z.infer<typeof DocumentEventSchema>;

export const DocumentDetailSchema = z.object({
  id: z.uuid(),
  status: DocumentStatusSchema,
  originalName: z.string(),
  sizeBytes: z.int(),
  pageCount: z.int().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Null while the document is still in flight, or if it failed. */
  extraction: ExtractionDetailSchema.nullable(),
  /** Append-only timeline — the answer to "why is this document stuck?". */
  events: z.array(DocumentEventSchema),
});
export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;

// ---------------------------------------------------------------- submitting a review

export const ReviewActionSchema = z.enum(['APPROVED', 'CORRECTED', 'REJECTED']);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;

/**
 * A single field correction, addressed by the same dotted path the confidence
 * policy and findings use, so the three line up in the UI without translation.
 */
export const CorrectionSchema = z.object({
  path: z.string().min(1),
  value: z.unknown(),
});
export type Correction = z.infer<typeof CorrectionSchema>;

export const ReviewRequestSchema = z
  .object({
    action: ReviewActionSchema,
    corrections: z.array(CorrectionSchema).optional(),
    /** Required when rejecting, so a rejection is never unexplained. */
    note: z.string().max(2_000).optional(),
  })
  .refine((body) => body.action !== 'CORRECTED' || (body.corrections?.length ?? 0) > 0, {
    message: 'A CORRECTED review must include at least one correction',
    path: ['corrections'],
  })
  .refine((body) => body.action !== 'REJECTED' || Boolean(body.note?.trim()), {
    message: 'A REJECTED review must include a note explaining why',
    path: ['note'],
  });
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ReviewResponseSchema = z.object({
  document: DocumentDetailSchema,
  /** Present when corrections created a new extraction version. */
  newVersion: z.int().nullable(),
});
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;
