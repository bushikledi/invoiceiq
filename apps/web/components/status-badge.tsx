import type { DocumentStatus } from '@invoiceiq/contracts';

/**
 * Status badge.
 *
 * Colours map one-to-one onto the domain state machine, so what a reviewer sees
 * and what the database holds cannot drift. Amber means "a human is needed",
 * green means done, red means failed, and everything still in flight is blue —
 * a reviewer scanning the list should be able to find the rows needing them
 * without reading a single word.
 *
 * The tones are semantic tokens rather than palette values, so the badge is
 * legible in both themes without a second set of classes. A raw amber tuned to
 * sit gently on white glows on near-black, and a column of "needs review"
 * badges at that intensity is the only thing anyone can look at.
 */
const STYLES: Record<DocumentStatus, string> = {
  UPLOADED: 'bg-surface-muted text-ink-muted ring-line',
  QUEUED: 'bg-info-soft text-info-ink ring-info-line',
  PROCESSING: 'bg-info-soft text-info-ink ring-info-line',
  EXTRACTED: 'bg-info-soft text-info-ink ring-info-line',
  VALIDATING: 'bg-info-soft text-info-ink ring-info-line',
  NEEDS_REVIEW: 'bg-caution-soft text-caution-ink ring-caution-line',
  COMPLETED: 'bg-positive-soft text-positive-ink ring-positive-line',
  FAILED: 'bg-critical-soft text-critical-ink ring-critical-line',
};

const LABELS: Record<DocumentStatus, string> = {
  UPLOADED: 'Uploaded',
  QUEUED: 'Queued',
  PROCESSING: 'Processing',
  EXTRACTED: 'Extracted',
  VALIDATING: 'Validating',
  NEEDS_REVIEW: 'Needs review',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

/** Statuses where the pipeline is still working, so the UI should keep watching. */
const IN_FLIGHT = new Set<DocumentStatus>([
  'UPLOADED',
  'QUEUED',
  'PROCESSING',
  'EXTRACTED',
  'VALIDATING',
]);

export const isInFlight = (status: DocumentStatus): boolean => IN_FLIGHT.has(status);

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span
      data-testid={`status-${status}`}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${STYLES[status]}`}
    >
      {/*
        The dot is decorative — the label already says "Processing", so
        announcing a bullet adds nothing but noise for a screen-reader user.
      */}
      {IN_FLIGHT.has(status) && (
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {LABELS[status]}
    </span>
  );
}
