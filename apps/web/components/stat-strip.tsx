'use client';

import { useQuery } from '@tanstack/react-query';
import type { DocumentStats } from '@invoiceiq/contracts';
import { api } from '../lib/api-client';
import { formatCost, formatPercent } from '../lib/format';

/**
 * Headline figures above the documents table.
 *
 * These three answer what someone evaluating the system actually asks: does it
 * work, how much human effort does it save, and what does it cost? Cost per
 * document is the one people find surprising — it makes "under $2 a month"
 * checkable rather than a claim.
 */
export function StatStrip() {
  const stats = useQuery({
    queryKey: ['document-stats'],
    queryFn: ({ signal }) => api.get<DocumentStats>('/documents/stats', signal),
    /**
     * Poll only while the pipeline is actually working — the same rule the
     * documents table follows.
     *
     * A fixed interval here would double the request rate of an idle dashboard
     * for numbers that cannot change, and stacked on top of the table's polling
     * it was enough to trip the global rate limit during testing.
     *
     * Since M11 the SSE stream invalidates this query directly, so the interval
     * is a fallback for a dropped connection rather than the primary path —
     * which is why it is slower than it used to be.
     */
    refetchInterval: (query) => ((query.state.data?.processing ?? 0) > 0 ? 5_000 : false),
  });

  if (!stats.data || stats.data.total === 0) return null;

  const { total, completed, needsReview, failed, autoApprovedRatio, totalCostUsd } = stats.data;

  return (
    <dl
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4"
      data-testid="stat-strip"
    >
      <Stat label="Documents" value={String(total)} detail={`${failed} failed`} />
      <Stat
        label="Auto-approved"
        value={formatPercent(autoApprovedRatio)}
        detail={`${completed} of ${completed + needsReview} decided`}
      />
      <Stat label="Awaiting review" value={String(needsReview)} detail="need a human" />
      <Stat
        label="LLM spend"
        value={formatCost(totalCostUsd)}
        detail={
          // Fixture runs genuinely cost nothing, and saying so is more honest
          // than showing $0.00 as though it were a real bill.
          totalCostUsd === 0 ? 'recorded fixtures' : 'across all extractions'
        }
      />
    </dl>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</dd>
      <dd className="text-xs text-ink-subtle">{detail}</dd>
    </div>
  );
}
