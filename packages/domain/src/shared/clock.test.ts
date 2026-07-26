import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock } from './clock.js';

describe('Clock', () => {
  describe('systemClock', () => {
    it('returns the current time', () => {
      const before = Date.now();
      const now = systemClock.now().getTime();
      const after = Date.now();
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after);
    });
  });

  describe('fixedClock', () => {
    it('accepts an ISO string', () => {
      const clock = fixedClock('2026-03-12T10:30:00.000Z');
      expect(clock.now().toISOString()).toBe('2026-03-12T10:30:00.000Z');
    });

    it('accepts a Date', () => {
      const clock = fixedClock(new Date('2026-03-12T00:00:00.000Z'));
      expect(clock.now().toISOString()).toBe('2026-03-12T00:00:00.000Z');
    });

    it('never advances', () => {
      const clock = fixedClock('2026-03-12T10:30:00.000Z');
      expect(clock.now().getTime()).toBe(clock.now().getTime());
    });

    it('hands out a fresh Date each call so a caller cannot mutate the clock', () => {
      // Date is mutable; returning the same instance would let one business rule
      // corrupt the clock for every rule that runs after it.
      const clock = fixedClock('2026-03-12T10:30:00.000Z');
      const first = clock.now();
      first.setFullYear(1999);
      expect(clock.now().getUTCFullYear()).toBe(2026);
    });

    it('rejects an invalid instant at construction time', () => {
      expect(() => fixedClock('not-a-date')).toThrowError(/invalid instant/);
    });
  });
});
