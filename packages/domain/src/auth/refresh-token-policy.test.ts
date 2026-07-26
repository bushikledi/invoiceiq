import { describe, expect, it } from 'vitest';
import {
  REFRESH_TOKEN_BYTES,
  evaluateRefreshToken,
  refreshTokenExpiry,
  type StoredRefreshToken,
} from './refresh-token-policy.js';

const NOW = new Date('2026-07-26T12:00:00.000Z');

const token = (overrides: Partial<StoredRefreshToken> = {}): StoredRefreshToken => ({
  expiresAt: new Date('2026-08-25T12:00:00.000Z'),
  revokedAt: null,
  replacedBy: null,
  ...overrides,
});

describe('evaluateRefreshToken', () => {
  describe('the happy path', () => {
    it('rotates a live, unused token', () => {
      expect(evaluateRefreshToken(token(), NOW)).toEqual({ kind: 'ROTATE' });
    });

    it('rotates a token expiring one millisecond from now', () => {
      const outcome = evaluateRefreshToken(token({ expiresAt: new Date(NOW.getTime() + 1) }), NOW);
      expect(outcome).toEqual({ kind: 'ROTATE' });
    });
  });

  describe('reuse detection', () => {
    it('flags a token that was already rotated away', () => {
      const outcome = evaluateRefreshToken(token({ replacedBy: 'successor-id' }), NOW);
      expect(outcome).toEqual({ kind: 'REUSE_DETECTED', reason: 'ALREADY_ROTATED' });
    });

    it('flags a token that was explicitly revoked', () => {
      const outcome = evaluateRefreshToken(token({ revokedAt: new Date('2026-07-20') }), NOW);
      expect(outcome).toEqual({ kind: 'REUSE_DETECTED', reason: 'REVOKED' });
    });

    it('reports reuse rather than expiry when a replayed token is ALSO expired', () => {
      // The ordering here is the whole point. If expiry won, an attacker could
      // simply wait out the clock and every replay would be written off as a
      // benign "your session ended" instead of raising a compromise signal.
      const outcome = evaluateRefreshToken(
        token({
          replacedBy: 'successor-id',
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        NOW,
      );
      expect(outcome).toEqual({ kind: 'REUSE_DETECTED', reason: 'ALREADY_ROTATED' });
    });

    it('prefers ALREADY_ROTATED over REVOKED when both are set', () => {
      // Family revocation stamps revokedAt on tokens that may already carry a
      // replacedBy. The rotation fact is the more precise diagnosis.
      const outcome = evaluateRefreshToken(
        token({ replacedBy: 'successor-id', revokedAt: new Date('2026-07-25') }),
        NOW,
      );
      expect(outcome).toEqual({ kind: 'REUSE_DETECTED', reason: 'ALREADY_ROTATED' });
    });
  });

  describe('expiry', () => {
    it('rejects a token past its expiry', () => {
      const outcome = evaluateRefreshToken(
        token({ expiresAt: new Date('2026-07-25T12:00:00.000Z') }),
        NOW,
      );
      expect(outcome).toEqual({ kind: 'EXPIRED' });
    });

    it('treats the exact expiry instant as spent', () => {
      // Boundary chosen deliberately: <= means a token is dead the moment it
      // reaches expiresAt, never one tick after.
      expect(evaluateRefreshToken(token({ expiresAt: NOW }), NOW)).toEqual({ kind: 'EXPIRED' });
    });
  });
});

describe('refreshTokenExpiry', () => {
  it('adds the given number of days', () => {
    expect(refreshTokenExpiry(NOW, 30).toISOString()).toBe('2026-08-25T12:00:00.000Z');
  });

  it('handles a single day', () => {
    expect(refreshTokenExpiry(NOW, 1).toISOString()).toBe('2026-07-27T12:00:00.000Z');
  });

  it('crosses a month boundary correctly', () => {
    expect(refreshTokenExpiry(new Date('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });

  it('does not mutate the instant it was given', () => {
    const now = new Date(NOW.getTime());
    refreshTokenExpiry(now, 30);
    expect(now.toISOString()).toBe(NOW.toISOString());
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects ttlDays of %s', (ttl) => {
    expect(() => refreshTokenExpiry(NOW, ttl)).toThrowError(/positive ttlDays/);
  });
});

describe('REFRESH_TOKEN_BYTES', () => {
  it('is at least 256 bits of entropy', () => {
    expect(REFRESH_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
  });
});
