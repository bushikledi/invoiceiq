/**
 * Whether the live stream is actually connected.
 *
 * Worth surfacing because the two states behave differently and the difference
 * is otherwise invisible: connected means status changes appear the instant
 * they happen, disconnected means the screens have fallen back to polling and
 * an update may be several seconds late. Someone watching a document they just
 * uploaded should be able to tell which of those they are looking at, rather
 * than concluding the pipeline has stalled.
 *
 * Disconnected is deliberately *not* styled as an error. The fallback works;
 * this is a degraded optimisation, not a fault, and dressing it in red would
 * train people to ignore red.
 */
export function LiveIndicator({ connected }: { connected: boolean }) {
  return (
    <span
      className="hidden items-center gap-1.5 rounded-full border border-line px-2 py-1 text-xs text-ink-muted sm:inline-flex"
      title={
        connected
          ? 'Connected — status updates arrive as they happen'
          : 'Reconnecting — falling back to periodic refresh'
      }
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${
          connected ? 'bg-positive' : 'animate-pulse bg-caution'
        }`}
      />
      {connected ? 'Live' : 'Reconnecting'}
    </span>
  );
}
