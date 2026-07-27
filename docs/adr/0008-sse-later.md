# 8. Poll first, SSE later

**Status:** accepted — SSE landed in M11; see the postscript

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

## Postscript (M11)

SSE landed, and the prediction above held: no component changed. Two things the
original decision did not anticipate are worth recording.

**Polling did not go away, and should not.** Redis pub/sub has no delivery
guarantee — an event published while a browser was disconnected is gone, with
nothing anywhere reporting a loss. So the database stays the source of truth and
the slow poll remains as the fallback. Treating the stream as authoritative
would have put correctness on a transport that cannot carry it. The header shows
"Live" or "Reconnecting" because the two states behave differently and a user
watching a document they just uploaded deserves to know which one they are in.

**`EventSource` was the obvious client and the wrong one.** It cannot set
request headers, so authenticating it means putting the access token in the
query string, where it lands in every access log, proxy log and `Referer`
between the browser and the server — a 15-minute bearer token becomes a
credential at rest in a dozen places nobody watches. Reading the stream with
`fetch` sends an ordinary `Authorization` header and reuses the refresh handling
the client already had. The cost is implementing reconnection ourselves, which
`EventSource` would have provided; roughly forty lines against a class of
credential leak that is invisible until someone reads a log.

**The invalidation had to be coalesced.** `invalidateQueries` refetches an
active query immediately, and one document emits several events on its way
through the pipeline. Invalidating per event turned a six-file drop into dozens
of refetches in two seconds and tripped the same rate limiter the original ADR
mentions — the identical failure, arrived at from the opposite direction.
