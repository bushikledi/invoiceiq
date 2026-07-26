import { z } from 'zod';

/**
 * Document upload and listing wire format.
 *
 * Upload is a three-step dance — presign, PUT direct to storage, confirm — so
 * that file bytes never pass through the API process. See ADR 0007.
 */

export const DocumentStatusSchema = z.enum([
  'UPLOADED',
  'QUEUED',
  'PROCESSING',
  'EXTRACTED',
  'VALIDATING',
  'NEEDS_REVIEW',
  'COMPLETED',
  'FAILED',
]);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/** The only content type we accept. OCR of scanned images is out of scope. */
export const PDF_CONTENT_TYPE = 'application/pdf';

/** 10 MB. Enforced at presign time and re-checked server-side on completion. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const CreateUploadRequestSchema = z.object({
  /**
   * Display name only — it is never used to build the storage key. Keys are
   * server-generated UUIDs, so a filename like `../../etc/passwd` is inert.
   */
  filename: z.string().min(1).max(255),
  sizeBytes: z
    .int()
    .positive()
    .max(MAX_UPLOAD_BYTES, `File must be at most ${MAX_UPLOAD_BYTES} bytes`),
  contentType: z.literal(PDF_CONTENT_TYPE),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

export const CreateUploadResponseSchema = z.object({
  documentId: z.uuid(),
  /** Presigned PUT. Short-lived and single-purpose. */
  uploadUrl: z.url(),
  s3Key: z.string(),
  expiresInSeconds: z.int().positive(),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;

export const DocumentSummarySchema = z.object({
  id: z.uuid(),
  status: DocumentStatusSchema,
  originalName: z.string(),
  sizeBytes: z.int(),
  pageCount: z.int().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const ListDocumentsQuerySchema = z.object({
  status: DocumentStatusSchema.optional(),
  /** Opaque compound cursor over (created_at, id). Clients must not parse it. */
  cursor: z.string().optional(),
  // Query params arrive as strings, so coercion is required here. z.coerce has
  // no `.int()` shortcut in Zod 4 — it must go through `.number().int()`.
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;

export const ListDocumentsResponseSchema = z.object({
  items: z.array(DocumentSummarySchema),
  /** Absent when there is no further page. */
  nextCursor: z.string().nullable(),
});
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponseSchema>;

export const DocumentFileResponseSchema = z.object({
  /** Presigned GET for the PDF viewer. */
  url: z.url(),
  expiresInSeconds: z.int().positive(),
});
export type DocumentFileResponse = z.infer<typeof DocumentFileResponseSchema>;

/**
 * Why an upload was rejected at the trust boundary.
 *
 * The client's claim that it uploaded a valid PDF is never taken at face
 * value: the server re-reads the object from storage and checks it.
 */
export const UPLOAD_REJECTIONS = {
  MISSING_OBJECT: 'No object was found at the expected key',
  SIZE_MISMATCH: 'Uploaded size does not match the declared size',
  TOO_LARGE: 'Uploaded file exceeds the maximum size',
  NOT_A_PDF: 'File does not begin with the %PDF- signature',
} as const;
