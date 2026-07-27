import type { ReactNode } from 'react';

/**
 * Every query has three states, and all three get a component here.
 *
 * A screen that renders only the success case looks finished right up until the
 * network is slow or the request fails, at which point it shows nothing and
 * says nothing. Making empty/loading/error first-class is the difference
 * between a demo and something a person could use.
 */

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-muted" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  traceId,
  onRetry,
}: {
  title?: string;
  message: string;
  traceId?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl border border-critical-line bg-critical-soft px-4 py-3" role="alert">
      <p className="text-sm font-medium text-critical-ink">{title}</p>
      <p className="mt-1 text-sm text-critical-ink/90">{message}</p>

      {/* Surfacing the trace id turns "it broke" into a support request that can
          actually be investigated — it is the same id in the server logs.
          `select-all` so one click selects the whole thing to paste. */}
      {traceId && (
        <p className="mt-2 select-all font-mono text-xs text-critical-ink/70">
          Reference: {traceId}
        </p>
      )}

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          // Ink-on-soft rather than white-on-critical. `--critical` is a light,
          // saturated red in the dark theme, where white text on it fails
          // contrast; inverting the tone family's own pair holds up in both,
          // because each theme already defines them as a legible couple.
          className="mt-3 rounded-md bg-critical-ink px-3 py-1.5 text-xs font-medium text-critical-soft transition hover:opacity-90"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  const tone = value >= 0.85 ? 'bg-positive' : value >= 0.6 ? 'bg-caution' : 'bg-critical';

  return (
    <div
      className="flex items-center gap-2"
      // A progressbar role rather than a title attribute: a title is invisible
      // to touch users and inconsistently announced, whereas this reads as
      // "Overall confidence, 97 percent" in every screen reader.
      role="progressbar"
      aria-label="Overall confidence"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="tabular-nums text-xs text-ink-muted">{percent}%</span>
    </div>
  );
}
