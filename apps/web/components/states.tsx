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
        <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
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
    <div className="rounded-lg border border-dashed border-slate-300 px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p>
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
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3" role="alert">
      <p className="text-sm font-medium text-rose-900">{title}</p>
      <p className="mt-1 text-sm text-rose-700">{message}</p>

      {/* Surfacing the trace id turns "it broke" into a support request that can
          actually be investigated — it is the same id in the server logs. */}
      {traceId && <p className="mt-2 font-mono text-xs text-rose-500">Reference: {traceId}</p>}

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  const tone = value >= 0.85 ? 'bg-emerald-500' : value >= 0.6 ? 'bg-amber-500' : 'bg-rose-500';

  return (
    <div className="flex items-center gap-2" title={`Overall confidence ${percent}%`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="tabular-nums text-xs text-slate-500">{percent}%</span>
    </div>
  );
}
