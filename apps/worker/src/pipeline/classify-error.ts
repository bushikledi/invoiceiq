import { LlmError } from '@invoiceiq/ai';
import { ScannedDocumentError, UnreadablePdfError } from './pdf-text.js';

/**
 * Splits failures into "try again later" and "this will never work".
 *
 * This one function decides whether a document gets three more expensive
 * attempts or is failed immediately, so getting it wrong is costly in both
 * directions:
 *
 *   - Treating a permanent failure as retriable means every scanned PDF is
 *     parsed three times and every malformed request re-sent, on a schedule,
 *     forever.
 *   - Treating a transient failure as terminal means a thirty-second Redis
 *     blip permanently fails a batch of documents that would have succeeded on
 *     the next attempt.
 *
 * Retriable failures are re-thrown so BullMQ re-runs the job with backoff.
 * Terminal failures are acknowledged and the document is marked FAILED with a
 * reason a human can act on.
 */

export type FailureClass =
  | { readonly kind: 'RETRIABLE'; readonly reason: string }
  | { readonly kind: 'TERMINAL'; readonly reason: string; readonly code: string };

/** Postgres/Redis/network conditions that clear on their own. */
const TRANSIENT_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /socket hang up/i,
  /connection terminated/i,
  /too many connections/i,
  /deadlock detected/i,
];

export function classifyError(error: unknown): FailureClass {
  // A scan will still be a scan on the fourth attempt.
  if (error instanceof ScannedDocumentError) {
    return { kind: 'TERMINAL', reason: error.message, code: error.reason };
  }

  // Corrupt bytes do not repair themselves.
  if (error instanceof UnreadablePdfError) {
    return { kind: 'TERMINAL', reason: error.message, code: error.reason };
  }

  // The AI layer has already made this judgement; trust it rather than
  // re-deriving it from a message string.
  if (error instanceof LlmError) {
    return error.retriable
      ? { kind: 'RETRIABLE', reason: error.message }
      : { kind: 'TERMINAL', reason: error.message, code: 'LLM_REQUEST_REJECTED' };
  }

  const message = error instanceof Error ? error.message : String(error);

  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: 'RETRIABLE', reason: message };
  }

  // Default to retriable. An unrecognised error is more likely to be
  // infrastructure than a permanent property of the document, and losing a
  // document is worse than spending a few extra attempts discovering otherwise.
  // BullMQ's attempt limit bounds the damage either way.
  return { kind: 'RETRIABLE', reason: message };
}

/** Terminal codes that describe the document rather than our systems. */
export const TERMINAL_CODES = {
  LIKELY_SCANNED_IMAGE: 'LIKELY_SCANNED_IMAGE',
  UNREADABLE_PDF: 'UNREADABLE_PDF',
  SCHEMA_FAILURE: 'SCHEMA_FAILURE',
  LLM_REQUEST_REJECTED: 'LLM_REQUEST_REJECTED',
} as const;
