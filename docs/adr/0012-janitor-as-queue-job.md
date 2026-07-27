# 12. The janitor is a queue job, not a cron

**Status:** accepted

## Context

Graceful shutdown handles the ordinary case: on SIGTERM, BullMQ finishes the
in-flight job before closing. It cannot handle SIGKILL, an OOM kill, or a node
disappearing — and those leave a document saying `PROCESSING` forever, with the
only remedy being a human running `UPDATE` against production.

## Decision

A **BullMQ repeatable job** on a `maintenance` queue, registered at boot with
`immediately: true`.

A matching **`POST /documents/:id/requeue`** for the case where someone is
watching and does not want to wait.

## Consequences

`@nestjs/schedule` would run the cron in _every_ replica. With three workers
that is three janitors waking simultaneously, each selecting the same stranded
rows, each enqueueing the same recovery. The transaction guard would survive it,
but it is a race deliberately introduced by the recovery mechanism — the last
place to have one. A repeatable job is coordinated through Redis: one instance
fires per interval regardless of replica count. The queue we already depend on
solves the leader election we would otherwise have to solve.

`immediately: true` matters more than it looks. Without it the first run is one
full interval away, so a worker booting after a crash — the exact moment
documents are most likely to be stranded — leaves them stranded for another five
minutes and reports no queue depth at all until then.

Reclaiming is safe in both directions because the processor refuses anything
that is not `QUEUED`. A job arriving for a document someone else already picked
up acknowledges itself and does nothing. The status guard, not job-id
uniqueness, is what actually prevents double processing — which is what made the
job-id change below safe.

## What this cost us

The recovery path could not reuse the document id as the job id, and finding out
why took a live experiment rather than a code review.

The first enqueue of a document uses the bare document id so BullMQ deduplicates
a retried upload — exactly right for "the same upload, submitted twice", and
exactly wrong for "run this again". BullMQ retains completed jobs, and `add()`
with an existing id **returns the existing job rather than throwing**. So a
requeue an hour after the original answered 200, moved the row to `QUEUED`, and
created no job at all: a worse state than the failure being recovered from, and
silent.

Recovery now uses `${documentId}:requeue:${timestamp}`. The regression test
counts jobs on the queue, because a 200 and a `QUEUED` row proved nothing — the
bug produced both.

The threshold also had to become per-status. `PROCESSING` means a worker took
the job and is never coming back: one threshold. `QUEUED` is _also_ the normal
state of a document waiting behind the rate limiter, where a backlog can
legitimately be tens of minutes deep — so it gets four times as long, and
reclaiming it re-creates the job without touching the row, because writing
`QUEUED` over `QUEUED` would bump `updated_at` and reset the very timer that
identified it as stuck.

## Alternatives

**BullMQ's stalled-job detection.** It handles a worker losing its lock, which
is the queue's view of the problem. It knows nothing about our `documents.status`
column, so a job it retries still finds a row that says `PROCESSING` and the
processor's guard declines it. The two mechanisms are complementary; only one of
them can see the database.

**A `PROCESSING` timeout enforced by the database.** A trigger or a scheduled
`UPDATE` would fix the row and leave no job behind it — recovering the symptom
and not the work.
