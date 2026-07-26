/**
 * Refresh-token rotation with reuse detection.
 *
 * The threat this defends against: an attacker steals a refresh token (XSS, a
 * leaked backup, a shared machine). With static refresh tokens they get
 * indefinite access and nobody ever finds out.
 *
 * With rotation, every refresh burns the presented token and issues a
 * replacement in the same *family*. So a stolen token can be used at most once,
 * and — crucially — the moment either party uses a token that has already been
 * replaced, we know there are two holders of what should be a single-use
 * secret. That is proof of compromise, not a guess, so the correct response is
 * to revoke the entire family and force a fresh login.
 *
 * Note the asymmetry that makes this work: whether the *victim* or the
 * *attacker* refreshes second, the second one triggers detection. The attacker
 * cannot avoid it without never using the token at all.
 *
 * This module is the decision; persistence and hashing live in infrastructure.
 */

/** State of a stored refresh token, as far as the policy cares. */
export interface StoredRefreshToken {
  readonly expiresAt: Date;
  /** Set when the token was explicitly revoked (logout, or family revocation). */
  readonly revokedAt: Date | null;
  /** Set when this token was rotated away — its successor's id. */
  readonly replacedBy: string | null;
}

export type RefreshOutcome =
  /** Valid and unused: issue a successor in the same family. */
  | { readonly kind: 'ROTATE' }
  /**
   * Presented after it had already been rotated or revoked. Treated as theft:
   * the caller must revoke the whole family, not just this token.
   */
  | { readonly kind: 'REUSE_DETECTED'; readonly reason: 'ALREADY_ROTATED' | 'REVOKED' }
  /** Past its expiry. Ordinary session end, not an attack. */
  | { readonly kind: 'EXPIRED' };

/**
 * Decides what to do with a presented refresh token.
 *
 * Order matters. Reuse is checked *before* expiry: a replayed token that has
 * also aged out is still evidence of compromise, and reporting it as a benign
 * "your session ended" would discard the security signal.
 */
export function evaluateRefreshToken(token: StoredRefreshToken, now: Date): RefreshOutcome {
  if (token.replacedBy !== null) {
    return { kind: 'REUSE_DETECTED', reason: 'ALREADY_ROTATED' };
  }

  if (token.revokedAt !== null) {
    return { kind: 'REUSE_DETECTED', reason: 'REVOKED' };
  }

  // Expiry is inclusive of the boundary: a token expiring exactly now is spent.
  if (token.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'EXPIRED' };
  }

  return { kind: 'ROTATE' };
}

/** Entropy for the opaque refresh token. 256 bits — brute force is not a threat model. */
export const REFRESH_TOKEN_BYTES = 32;

/** Computes the absolute expiry for a newly issued refresh token. */
export function refreshTokenExpiry(now: Date, ttlDays: number): Date {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error(`refreshTokenExpiry requires a positive ttlDays, received ${ttlDays}`);
  }
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
}
