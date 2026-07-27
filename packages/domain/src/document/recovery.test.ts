import { describe, expect, it } from 'vitest';
import { RECLAIMABLE_STATUSES, canRequeue, isStranded, reclaimAfterMinutes } from './recovery.js';
import { DOCUMENT_STATUSES, type DocumentStatus } from './document-status.js';

const NOW = new Date('2026-07-27T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const doc = (status: DocumentStatus, updatedAt: Date) => ({ status, updatedAt });

describe('isStranded', () => {
  it('reclaims a document that has been PROCESSING past the threshold', () => {
    expect(isStranded(doc('PROCESSING', minutesAgo(20)), NOW, 15)).toBe(true);
  });

  it('leaves a document that is merely slow alone', () => {
    expect(isStranded(doc('PROCESSING', minutesAgo(14)), NOW, 15)).toBe(false);
  });

  it('treats exactly the threshold as stranded', () => {
    // The boundary has to land somewhere; stating which side keeps the janitor
    // and the requeue endpoint from disagreeing about the same document.
    expect(isStranded(doc('PROCESSING', minutesAgo(15)), NOW, 15)).toBe(true);
  });

  it('ignores every status that is not recoverable, however old', () => {
    const others = DOCUMENT_STATUSES.filter((status) => !RECLAIMABLE_STATUSES.includes(status));

    for (const status of others) {
      expect(isStranded(doc(status, minutesAgo(10_000)), NOW, 15)).toBe(false);
    }
  });

  it('is far more patient with QUEUED than with PROCESSING', () => {
    // QUEUED is the normal state of a document waiting behind the rate limiter,
    // so a threshold that reclaims it as eagerly as a crashed PROCESSING job
    // would enqueue a second copy of work that was already scheduled.
    expect(isStranded(doc('QUEUED', minutesAgo(20)), NOW, 15)).toBe(false);
    expect(isStranded(doc('QUEUED', minutesAgo(61)), NOW, 15)).toBe(true);
  });

  it('exposes the per-status window it actually applied', () => {
    expect(reclaimAfterMinutes('PROCESSING', 15)).toBe(15);
    expect(reclaimAfterMinutes('QUEUED', 15)).toBe(60);
    expect(reclaimAfterMinutes('COMPLETED', 15)).toBeNull();
  });

  it('does not strand a document whose row is timestamped in the future', () => {
    // Clock skew between the database and the worker. An unsigned comparison
    // here would requeue every in-flight document the moment NTP corrected.
    const future = new Date(NOW.getTime() + 60_000);
    expect(isStranded(doc('PROCESSING', future), NOW, 15)).toBe(false);
  });
});

describe('canRequeue', () => {
  it('allows a failed document straight back onto the queue', () => {
    expect(canRequeue(doc('FAILED', minutesAgo(1)), NOW, 15)).toEqual({ ok: true });
  });

  it('allows a stranded document', () => {
    expect(canRequeue(doc('PROCESSING', minutesAgo(30)), NOW, 15)).toEqual({ ok: true });
  });

  it('refuses a document still plausibly being worked on, and says so distinctly', () => {
    expect(canRequeue(doc('PROCESSING', minutesAgo(2)), NOW, 15)).toEqual({
      ok: false,
      reason: { kind: 'STILL_WORKING', status: 'PROCESSING' },
    });
  });

  it('refuses a completed document as a matter of the state machine, not of timing', () => {
    expect(canRequeue(doc('COMPLETED', minutesAgo(10_000)), NOW, 15)).toEqual({
      ok: false,
      reason: { kind: 'ILLEGAL_TRANSITION', status: 'COMPLETED' },
    });
  });

  it('refuses every status the state machine has no QUEUED edge from', () => {
    const noEdge: DocumentStatus[] = ['COMPLETED', 'EXTRACTED', 'VALIDATING', 'NEEDS_REVIEW'];

    for (const status of noEdge) {
      expect(canRequeue(doc(status, minutesAgo(10_000)), NOW, 15)).toMatchObject({
        ok: false,
        reason: { kind: 'ILLEGAL_TRANSITION' },
      });
    }
  });

  it('refuses a QUEUED document that is merely waiting its turn', () => {
    expect(canRequeue(doc('QUEUED', minutesAgo(30)), NOW, 15)).toEqual({
      ok: false,
      reason: { kind: 'STILL_WORKING', status: 'QUEUED' },
    });
  });

  it('allows a QUEUED document that has waited past any plausible backlog', () => {
    // The case this recovers: the transaction committed and the enqueue then
    // failed, so the row says QUEUED and no job exists to move it out.
    expect(canRequeue(doc('QUEUED', minutesAgo(90)), NOW, 15)).toEqual({ ok: true });
  });
});
