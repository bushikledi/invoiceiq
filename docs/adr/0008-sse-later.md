# 8. Poll first, SSE later

**Status:** accepted

## Context

The dashboard must show a document move `QUEUED → PROCESSING → NEEDS_REVIEW`
without a manual refresh.

## Decision

Poll while work is in flight. Add SSE over Redis pub/sub afterwards.

## Consequences

TanStack Query's `refetchInterval` returns `false` when nothing is in flight, so
an idle dashboard makes no requests at all — the cost is bounded by actual
activity rather than by wall-clock time.

The upgrade is genuinely cheap because TanStack Query owns the cache either way:
SSE writes into the same cache the components already read, so the transport
changes and no component does. That is what makes deferring it defensible rather
than a shortcut.

An early version polled the stats endpoint on a fixed 5-second interval while
the table polled every 2 seconds. Stacked, that was enough to trip the global
rate limit during local testing — which is a small illustration of why "just
poll on a timer" is not free.

## Alternatives

**WebSockets.** Bidirectional, which this need is not: the server talks, the
client listens. Rejected as infrastructure for a capability nothing requires.
