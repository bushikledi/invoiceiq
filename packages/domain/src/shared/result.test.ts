import { describe, expect, it } from 'vitest';
import { all, andThen, err, isErr, isOk, map, mapErr, ok, unwrap, unwrapOr } from './result.js';

describe('Result', () => {
  describe('construction and narrowing', () => {
    it('narrows an Ok to its value type', () => {
      const result = ok(42);
      expect(isOk(result)).toBe(true);
      expect(isErr(result)).toBe(false);
      if (isOk(result)) {
        // Type-level assertion: `.value` is only reachable after narrowing.
        expect(result.value).toBe(42);
      }
    });

    it('narrows an Err to its error type', () => {
      const result = err({ kind: 'SCHEMA_FAILURE' as const });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('SCHEMA_FAILURE');
      }
    });

    it('treats a falsy success value as a success', () => {
      // The discriminant is `ok`, never truthiness of the payload — a legitimately
      // zero total or empty string must not be mistaken for a failure.
      expect(isOk(ok(0))).toBe(true);
      expect(isOk(ok(''))).toBe(true);
      expect(isOk(ok(null))).toBe(true);
      expect(isOk(ok(false))).toBe(true);
    });
  });

  describe('map', () => {
    it('transforms a success', () => {
      expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
    });

    it('leaves a failure untouched and does not run the function', () => {
      let called = false;
      const result = map(err<string>('boom'), (n: number) => {
        called = true;
        return n * 3;
      });
      expect(result).toEqual(err('boom'));
      expect(called).toBe(false);
    });
  });

  describe('mapErr', () => {
    it('transforms a failure', () => {
      expect(mapErr(err('boom'), (e) => `wrapped: ${e}`)).toEqual(err('wrapped: boom'));
    });

    it('leaves a success untouched', () => {
      expect(mapErr(ok(1), () => 'never')).toEqual(ok(1));
    });
  });

  describe('andThen', () => {
    const positive = (n: number) => (n > 0 ? ok(n) : err('not positive'));

    it('chains successful operations', () => {
      expect(andThen(ok(5), positive)).toEqual(ok(5));
    });

    it('short-circuits on the first failure', () => {
      expect(andThen(ok(-1), positive)).toEqual(err('not positive'));
    });

    it('does not invoke the continuation when already failed', () => {
      let called = false;
      andThen(err<string>('earlier'), (n: number) => {
        called = true;
        return positive(n);
      });
      expect(called).toBe(false);
    });
  });

  describe('unwrapOr', () => {
    it('returns the value on success', () => {
      expect(unwrapOr(ok(1), 99)).toBe(1);
    });

    it('returns the fallback on failure', () => {
      expect(unwrapOr(err<string>('boom'), 99)).toBe(99);
    });
  });

  describe('unwrap', () => {
    it('returns the value on success', () => {
      expect(unwrap(ok('value'))).toBe('value');
    });

    it('throws with the serialised error on failure', () => {
      expect(() => unwrap(err({ kind: 'BAD' }))).toThrowError(/Called unwrap\(\) on an Err/);
      expect(() => unwrap(err({ kind: 'BAD' }))).toThrowError(/BAD/);
    });
  });

  describe('all', () => {
    it('collects successes in order', () => {
      expect(all([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
    });

    it('returns the first failure', () => {
      expect(all([ok(1), err('first'), err('second')])).toEqual(err('first'));
    });

    it('returns an empty success for an empty input', () => {
      expect(all([])).toEqual(ok([]));
    });
  });
});
