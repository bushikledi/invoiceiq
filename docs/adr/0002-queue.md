# 2. A queue between the API and the LLM

**Status:** Accepted · **Date:** 2026-07-26

## Context

Extracting an invoice takes 5–60 seconds: a PDF fetch, a text extraction, one
to three LLM calls with corrective retries, then validation and persistence.
Proxies and load balancers typically cut idle HTTP connections at 30–60
seconds. A synchronous endpoint is therefore not slow — it is *unreliable*, and
unreliable in the worst way, because the work often succeeded server-side while
the client saw a timeout.

Retries make it worse. A client that retries a timed-out extraction bills a
second LLM call for a document that already succeeded.

## Decision

HTTP handlers never call the LLM. Upload records the document and enqueues a
job; a separate worker process consumes it. BullMQ on Redis, which we need for
caching anyway.

**`jobId = documentId`.** BullMQ refuses a duplicate job id, so enqueueing the
same document twice is a no-op. Combined with a status guard in the processor
(proceed only from `QUEUED`), this gives end-to-end idempotency — the answer to
"what if the enqueue succeeds but the HTTP response is lost?" is "nothing
happens twice".

**Two layers of retry, deliberately not conflated.** BullMQ attempts handle
*transient* failures — network, 429, provider 5xx — with exponential backoff.
The corrective-schema loop lives *inside* a single attempt and handles
*semantic* failure, feeding specific Zod issues back to the model. Retrying a
schema violation with backoff would just buy the same malformed JSON later.

## Consequences

**Good.** Uploads stay fast under load; extraction backpressure is absorbed by
queue depth rather than by timeouts. Workers scale horizontally with no
coordination, because jobs are single-document and idempotent. A crash in LLM
handling cannot take down the API.

**Bad.** The UI is eventually consistent — a freshly uploaded document is
`QUEUED`, not done. Solved by polling now, SSE later, with the same TanStack
Query cache either way. It is also one more process to run and observe.

**Operational requirement.** Redis must run with `maxmemory-policy noeviction`.
Any eviction policy would silently drop jobs under memory pressure.

**Graceful drain is load-bearing.** On SIGTERM the worker closes the BullMQ
worker, which waits for the in-flight job rather than killing it, so a deploy
never strands a document in `PROCESSING`. This only works if the signal
actually reaches node — hence `dumb-init` as the container entrypoint. The
janitor cron is the backstop for SIGKILL and OOM, not the primary mechanism.

## Alternatives

- **pg-boss.** The strongest counterargument: one fewer datastore, and
  transactional enqueue in the same commit as the document row. Rejected
  because we want Redis anyway and BullMQ's rate limiting, repeatable jobs, and
  dead-letter ergonomics are more mature. Worth revisiting if Redis ever exists
  *only* for the queue.
- **SQS.** Vendor lock-in and no local-dev story worth the trouble at this size.
- **Synchronous with a longer timeout.** Does not survive contact with a proxy.
