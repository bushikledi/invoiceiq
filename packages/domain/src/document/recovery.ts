import type { DocumentStatus } from './document-status.js';
import { canTransition } from './document-status.js';

/**
 * When is a document stuck, and what may be done about it?
 *
 * Both questions are pure policy, so they live here rather than inside the
 * janitor. That is not tidiness — it is what makes the interesting cases
 * testable. "A document that has been PROCESSING for exactly the threshold" and
 * "a clock that jumped backwards" are one-line tests here; reproducing either
 * against a live queue and a real database is most of an afternoon.
 */

/**
 * How long each reclaimable status may sit before the janitor acts, as a
 * multiple of the configured threshold.
 *
 * PROCESSING and QUEUED are both recoverable, but they fail in different ways
 * and deserve different patience:
 *
 *   - **PROCESSING** means a worker took the job and never came back. Nothing
 *     else will ever move it. One threshold.
 *
 *   - **QUEUED** means the row says "waiting" and there may be no job waiting
 *     for it — the narrow window where the transaction committed and the
 *     enqueue then failed. But QUEUED is *also* the normal state of a document
 *     genuinely sitting behind the rate limiter, and at ten extractions a
 *     minute a backlog can legitimately be tens of minutes deep. Reclaiming
 *     those would enqueue a second job for work already scheduled. A longer
 *     multiple keeps the recovery without the false positives.
 */
const RECLAIM_AFTER: Partial<Record<DocumentStatus, number>> = {
  PROCESSING: 1,
  QUEUED: 4,
};

export interface StrandedInput {
  readonly status: DocumentStatus;
  /** Last write to the document row — set by the transition into this status. */
  readonly updatedAt: Date;
}

/**
 * Has this document been in a recoverable status longer than anything
 * legitimate takes?
 *
 * The threshold is a *timeout*, not an SLA. Set it below the real p99 and the
 * janitor reclaims documents that were merely slow — paying for them twice and,
 * worse, doing so most often on exactly the large multi-page invoices that are
 * slowest and most expensive. Generous is the safe direction to be wrong in:
 * the cost of waiting an extra ten minutes is a delay, the cost of reclaiming
 * early is a duplicate bill and a confusing timeline.
 *
 * Reclaiming is safe in both directions regardless, because the extraction
 * processor refuses any document that is not QUEUED — so a job that arrives for
 * a document someone else already picked up acknowledges itself without working.
 */
export function isStranded(input: StrandedInput, now: Date, thresholdMinutes: number): boolean {
  const multiplier = RECLAIM_AFTER[input.status];
  if (multiplier === undefined) return false;

  const elapsedMs = now.getTime() - input.updatedAt.getTime();

  // A negative elapsed time means the row is timestamped in the future: clock
  // skew between the database and this process, or an NTP correction. Treating
  // it as "elapsed = huge" via an unsigned comparison would reclaim every
  // in-flight document the moment the clocks disagreed.
  if (elapsedMs < 0) return false;

  return elapsedMs >= thresholdMinutes * multiplier * 60_000;
}

/** The statuses the janitor will look at, for the SQL prefilter. */
export const RECLAIMABLE_STATUSES = Object.keys(RECLAIM_AFTER) as DocumentStatus[];

/** Minutes a status must sit before `isStranded` will reclaim it. */
export function reclaimAfterMinutes(
  status: DocumentStatus,
  thresholdMinutes: number,
): number | null {
  const multiplier = RECLAIM_AFTER[status];
  return multiplier === undefined ? null : multiplier * thresholdMinutes;
}

export type RequeueRefusal =
  | { readonly kind: 'ILLEGAL_TRANSITION'; readonly status: DocumentStatus }
  | { readonly kind: 'STILL_WORKING'; readonly status: DocumentStatus };

/**
 * May this document be pushed back onto the queue right now?
 *
 * Two distinct refusals, because they need different answers in the UI. A
 * COMPLETED document can never be requeued — that is a permanent property of
 * the state machine, and the button should not exist. A document that is
 * PROCESSING but not yet stranded merely cannot be requeued *yet*, and telling
 * an operator "not yet, it has been running four minutes" is far more useful
 * than a flat refusal that invites them to retry in a loop.
 */
export function canRequeue(
  input: StrandedInput,
  now: Date,
  thresholdMinutes: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: RequeueRefusal } {
  // Recoverable statuses are decided by the clock, not by the transition table,
  // and the two disagree about QUEUED on purpose. `QUEUED → QUEUED` is not a
  // legal *transition* — nothing about the document changes — but it is a legal
  // *requeue*, because what is being replaced is the missing job, not the
  // status. Consulting the transition table first would refuse exactly the case
  // this exists to recover.
  if (reclaimAfterMinutes(input.status, thresholdMinutes) !== null) {
    return isStranded(input, now, thresholdMinutes)
      ? { ok: true }
      : { ok: false, reason: { kind: 'STILL_WORKING', status: input.status } };
  }

  // Everything else is a genuine state change, so the state machine decides.
  // FAILED → QUEUED is the one it permits: nothing is in flight, so a retry
  // cannot duplicate work.
  return canTransition(input.status, 'QUEUED')
    ? { ok: true }
    : { ok: false, reason: { kind: 'ILLEGAL_TRANSITION', status: input.status } };
}
