import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { REFRESH_TOKEN_BYTES } from '@invoiceiq/domain';
import type { ApiEnv } from '@invoiceiq/config';
import type { UserRole } from '@invoiceiq/contracts';
import { API_ENV } from '../../config/config.module.js';

/** Claims we put in the access token. Deliberately minimal. */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: UserRole;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * Signs a short-lived access token.
   *
   * HS256 rather than RS256: there is exactly one issuer and one audience, both
   * of which are this application, so asymmetric keys would add key
   * distribution and rotation work for no threat-model benefit. If a second
   * service ever needs to verify these independently, that is the moment to
   * switch — and the reason to, which is worth being able to articulate.
   */
  signAccessToken(claims: AccessTokenClaims): string {
    return this.jwt.sign(claims);
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return this.jwt.verify<AccessTokenClaims>(token);
  }

  /**
   * Mints an opaque refresh token.
   *
   * Opaque, not a JWT: a refresh token must be revocable, and a self-contained
   * JWT is valid until it expires no matter what the server thinks. Storing a
   * random value means revocation is a database write.
   */
  generateRefreshToken(): string {
    return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  /**
   * Only the hash is stored, so a database leak yields no usable sessions.
   *
   * Plain SHA-256 rather than argon2 here, unlike passwords: the input is 256
   * bits of machine-generated entropy, so there is no dictionary to attack and
   * nothing for a slow KDF to buy. It also keeps refresh cheap enough to run on
   * every token rotation.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Constant-time comparison, so failures leak no information via timing. */
  safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  /** Access-token lifetime in seconds, for the `expiresIn` field of the response. */
  accessTokenTtlSeconds(): number {
    return parseDuration(this.env.ACCESS_TOKEN_TTL);
  }
}

/** Converts `15m` / `900s` / `1h` / `900` into seconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported duration format: "${value}". Use e.g. 900, 15m, 1h, 7d.`);
  }

  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's'] ?? 1;
  return amount * multiplier;
}
