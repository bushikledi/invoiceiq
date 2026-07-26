import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '../shared/errors.js';
import {
  DOCUMENT_STATUSES,
  IN_FLIGHT_STATUSES,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
  legalTransitions,
  type DocumentStatus,
} from './document-status.js';

/**
 * The full transition matrix is asserted exhaustively: every one of the 8×8
 * pairs is either explicitly legal or explicitly illegal. A table this small
 * has no excuse for partial coverage, and it is exactly the kind of thing that
 * rots silently when someone adds a status.
 */
const LEGAL = new Set(legalTransitions().map(([from, to]) => `${from}->${to}`));

describe('document state machine', () => {
  describe('the complete transition matrix', () => {
    const pairs = DOCUMENT_STATUSES.flatMap((from) =>
      DOCUMENT_STATUSES.map((to) => [from, to] as const),
    );

    it.each(pairs)('%s -> %s', (from, to) => {
      expect(canTransition(from, to)).toBe(LEGAL.has(`${from}->${to}`));
    });

    it('covers every status as a source', () => {
      // Guards against someone adding a status to the enum but not the table.
      for (const status of DOCUMENT_STATUSES) {
        expect(() => canTransition(status, 'FAILED')).not.toThrow();
      }
    });
  });

  describe('the happy path', () => {
    it('walks upload through to completion', () => {
      const path: DocumentStatus[] = [
        'UPLOADED',
        'QUEUED',
        'PROCESSING',
        'EXTRACTED',
        'VALIDATING',
        'COMPLETED',
      ];

      for (let i = 0; i < path.length - 1; i++) {
        expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
      }
    });

    it('walks the review path', () => {
      expect(canTransition('VALIDATING', 'NEEDS_REVIEW')).toBe(true);
      expect(canTransition('NEEDS_REVIEW', 'COMPLETED')).toBe(true);
    });
  });

  describe('recovery paths', () => {
    it('lets the janitor rescue a document stranded in PROCESSING', () => {
      // A SIGKILL'd worker leaves PROCESSING rows with nothing coming back for
      // them. Without this edge they would be stuck forever.
      expect(canTransition('PROCESSING', 'QUEUED')).toBe(true);
    });

    it('lets an admin requeue a FAILED document', () => {
      expect(canTransition('FAILED', 'QUEUED')).toBe(true);
    });

    it('lets a rejected correction leave the document in NEEDS_REVIEW', () => {
      expect(canTransition('NEEDS_REVIEW', 'NEEDS_REVIEW')).toBe(true);
    });
  });

  describe('invariants that must never break', () => {
    it('never allows anything to leave COMPLETED', () => {
      // COMPLETED is the audit record. A later correction creates a new
      // extraction version rather than reopening the lifecycle.
      for (const to of DOCUMENT_STATUSES) {
        expect(canTransition('COMPLETED', to)).toBe(false);
      }
    });

    it('never allows FAILED to jump straight to COMPLETED', () => {
      expect(canTransition('FAILED', 'COMPLETED')).toBe(false);
    });

    it('never allows skipping extraction', () => {
      expect(canTransition('QUEUED', 'COMPLETED')).toBe(false);
      expect(canTransition('UPLOADED', 'PROCESSING')).toBe(false);
      expect(canTransition('PROCESSING', 'COMPLETED')).toBe(false);
    });

    it('never allows moving backwards through the pipeline', () => {
      expect(canTransition('EXTRACTED', 'PROCESSING')).toBe(false);
      expect(canTransition('VALIDATING', 'EXTRACTED')).toBe(false);
      expect(canTransition('COMPLETED', 'NEEDS_REVIEW')).toBe(false);
    });

    it('allows failure from every non-terminal status', () => {
      // Anything still in flight can hit an unrecoverable error.
      for (const status of IN_FLIGHT_STATUSES) {
        expect(canTransition(status, 'FAILED')).toBe(true);
      }
      expect(canTransition('NEEDS_REVIEW', 'FAILED')).toBe(true);
    });

    it('treats a status as its own successor only where explicitly allowed', () => {
      for (const status of DOCUMENT_STATUSES) {
        const selfAllowed = status === 'NEEDS_REVIEW';
        expect(canTransition(status, status)).toBe(selfAllowed);
      }
    });
  });

  describe('assertTransition', () => {
    it('passes silently for a legal move', () => {
      expect(() => assertTransition('QUEUED', 'PROCESSING')).not.toThrow();
    });

    it('throws IllegalTransitionError naming both states', () => {
      expect(() => assertTransition('COMPLETED', 'QUEUED')).toThrow(IllegalTransitionError);
      expect(() => assertTransition('COMPLETED', 'QUEUED')).toThrow(/COMPLETED.*QUEUED/);
    });

    it('carries the states as structured context for logging', () => {
      try {
        assertTransition('COMPLETED', 'QUEUED');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(IllegalTransitionError);
        expect((error as IllegalTransitionError).from).toBe('COMPLETED');
        expect((error as IllegalTransitionError).to).toBe('QUEUED');
      }
    });
  });

  describe('status classification', () => {
    it('marks exactly COMPLETED and FAILED as terminal', () => {
      expect([...TERMINAL_STATUSES].sort()).toEqual(['COMPLETED', 'FAILED']);
      expect(isTerminal('COMPLETED')).toBe(true);
      expect(isTerminal('FAILED')).toBe(true);
      expect(isTerminal('NEEDS_REVIEW')).toBe(false);
    });

    it('does not classify NEEDS_REVIEW as in-flight', () => {
      // The UI polls in-flight documents. NEEDS_REVIEW is waiting on a human,
      // not on the pipeline, so polling it would be pure wasted traffic.
      expect(IN_FLIGHT_STATUSES).not.toContain('NEEDS_REVIEW');
    });

    it('partitions every status into exactly one of terminal, in-flight or awaiting-review', () => {
      for (const status of DOCUMENT_STATUSES) {
        const inTerminal = TERMINAL_STATUSES.includes(status);
        const inFlight = IN_FLIGHT_STATUSES.includes(status);
        const awaitingReview = status === 'NEEDS_REVIEW';
        expect([inTerminal, inFlight, awaitingReview].filter(Boolean)).toHaveLength(1);
      }
    });
  });
});
