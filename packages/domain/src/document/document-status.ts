import { IllegalTransitionError } from '../shared/errors.js';

/**
 * The document lifecycle, modelled explicitly.
 *
 *   UPLOADED → QUEUED → PROCESSING → EXTRACTED → VALIDATING ─┬→ COMPLETED
 *                                                             └→ NEEDS_REVIEW → COMPLETED
 *                          │
 *                          └→ FAILED (unrecoverable) → QUEUED (admin requeue)
 *
 * Making the state machine a first-class thing — rather than a status column
 * that any service may assign — is what stops a document silently moving from
 * FAILED back to COMPLETED because one code path forgot to check. Every
 * transition is either in this table or it is a bug.
 */
export const DOCUMENT_STATUSES = [
  'UPLOADED',
  'QUEUED',
  'PROCESSING',
  'EXTRACTED',
  'VALIDATING',
  'NEEDS_REVIEW',
  'COMPLETED',
  'FAILED',
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * Legal transitions, as an adjacency map.
 *
 * Notable entries and why they exist:
 *  - PROCESSING → QUEUED: the M11 janitor rescues documents stranded by a
 *    SIGKILL'd worker. Without it a crash means a permanently stuck row.
 *  - FAILED → QUEUED: the admin requeue endpoint. Failure is not a dead end.
 *  - NEEDS_REVIEW → NEEDS_REVIEW: a reviewer can submit a correction that still
 *    violates a rule; the document stays put rather than illegally advancing.
 *  - Nothing leaves COMPLETED. A completed document is the audit record; a
 *    later correction creates a new extraction version, not a new lifecycle.
 */
const TRANSITIONS: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  UPLOADED: ['QUEUED', 'FAILED'],
  QUEUED: ['PROCESSING', 'FAILED'],
  PROCESSING: ['EXTRACTED', 'FAILED', 'QUEUED'],
  EXTRACTED: ['VALIDATING', 'FAILED'],
  VALIDATING: ['NEEDS_REVIEW', 'COMPLETED', 'FAILED'],
  NEEDS_REVIEW: ['COMPLETED', 'NEEDS_REVIEW', 'FAILED'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
};

/** Statuses from which no further work happens without human or admin action. */
export const TERMINAL_STATUSES: readonly DocumentStatus[] = ['COMPLETED', 'FAILED'];

/** Statuses the UI should keep polling. */
export const IN_FLIGHT_STATUSES: readonly DocumentStatus[] = [
  'UPLOADED',
  'QUEUED',
  'PROCESSING',
  'EXTRACTED',
  'VALIDATING',
];

export const isTerminal = (status: DocumentStatus): boolean => TERMINAL_STATUSES.includes(status);

export const canTransition = (from: DocumentStatus, to: DocumentStatus): boolean =>
  TRANSITIONS[from].includes(to);

/**
 * Throws unless the transition is legal.
 *
 * Call this at every status write. It is deliberately an exception rather than
 * a Result: an illegal transition is a programming error, not an anticipated
 * outcome, and the exception filter already maps it to a 409.
 */
export function assertTransition(from: DocumentStatus, to: DocumentStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/** Every legal (from, to) pair — used to drive the exhaustive transition tests. */
export function legalTransitions(): ReadonlyArray<readonly [DocumentStatus, DocumentStatus]> {
  return DOCUMENT_STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as const));
}
