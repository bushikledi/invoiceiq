import type { DocumentStatus } from '@invoiceiq/contracts';

/**
 * Status badge.
 *
 * Colours map one-to-one onto the domain state machine, so what a reviewer sees
 * and what the database holds cannot drift. Amber means "a human is needed",
 * green means done, red means failed, and everything still in flight is blue —
 * a reviewer scanning the list should be able to find the rows needing them
 * without reading a single word.
 */
const STYLES: Record<DocumentStatus, string> = {
  UPLOADED: 'bg-slate-100 text-slate-700 ring-slate-200',
  QUEUED: 'bg-sky-50 text-sky-700 ring-sky-200',
  PROCESSING: 'bg-sky-50 text-sky-700 ring-sky-200',
  EXTRACTED: 'bg-sky-50 text-sky-700 ring-sky-200',
  VALIDATING: 'bg-sky-50 text-sky-700 ring-sky-200',
  NEEDS_REVIEW: 'bg-amber-50 text-amber-800 ring-amber-300',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  FAILED: 'bg-rose-50 text-rose-700 ring-rose-200',
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

/** Statuses where the pipeline is still working, so the UI should keep polling. */
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
      {IN_FLIGHT.has(status) && (
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {LABELS[status]}
    </span>
  );
}
