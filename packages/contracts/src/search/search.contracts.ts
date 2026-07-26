import { z } from 'zod';
import { DocumentStatusSchema } from '../documents/document.contracts.js';

export const SearchQuerySchema = z.object({
  q: z.string().min(2, 'Search for at least two characters').max(500),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchHitSchema = z.object({
  documentId: z.uuid(),
  originalName: z.string(),
  status: DocumentStatusSchema,
  /** The chunk that matched, shown as the result snippet. */
  snippet: z.string(),
  /** 'synthetic' hits are the generated invoice summary; 'raw' is PDF text. */
  kind: z.string(),
  /** 0..1, where 1 is identical. Derived from cosine distance. */
  score: z.number(),
  invoiceNumber: z.string().nullable(),
  vendorName: z.string().nullable(),
  totalCents: z.number().int().nullable(),
  currency: z.string().nullable(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  hits: z.array(SearchHitSchema),
  /** Milliseconds spent in the database, so the demo can show it is fast. */
  tookMs: z.number(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// ---------------------------------------------------------------- export

export const ExportFormatSchema = z.enum(['csv', 'json']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const ExportQuerySchema = z.object({
  format: ExportFormatSchema.default('csv'),
  status: DocumentStatusSchema.optional(),
  /** Inclusive ISO dates, filtering on upload time. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type ExportQuery = z.infer<typeof ExportQuerySchema>;

/**
 * CSV is flattened to one row per line item, with the document columns
 * repeated.
 *
 * The alternative — one row per document with the items packed into a cell —
 * cannot be pivoted, filtered or summed in a spreadsheet, which is the only
 * reason anyone asks for CSV. Repetition is the cost of a format the recipient
 * can actually use.
 */
export const CSV_COLUMNS = [
  'document_id',
  'original_name',
  'status',
  'uploaded_at',
  'vendor_name',
  'vendor_vat_number',
  'invoice_number',
  'issue_date',
  'due_date',
  'currency',
  'line_number',
  'line_description',
  'line_quantity',
  'line_unit_price',
  'line_vat_rate_percent',
  'line_total',
  'subtotal',
  'vat_total',
  'total',
  'overall_confidence',
  'extraction_version',
  'model',
  'cost_usd',
] as const;
