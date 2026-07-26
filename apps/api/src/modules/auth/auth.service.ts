import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { hash, verify } from '@node-rs/argon2';
import {
  AuthenticationError,
  ConflictError,
  PASSWORD_HASH_PARAMS,
  evaluateRefreshToken,
  normalizeEmail,
  refreshTokenExpiry,
  systemClock,
  type Clock,
} from '@invoiceiq/domain';
import type { AuthResponse, AuthenticatedUser } from '@invoiceiq/contracts';
import { Prisma, UserRole, type PrismaClient } from '@invoiceiq/database';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { TokenService } from './token.service.js';

/** What a caller needs in order to set the refresh cookie. */
export interface IssuedSession {
  response: AuthResponse;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * A dummy argon2 hash, verified against whenever an unknown email logs in.
 *
 * Without it, a request for a non-existent user returns in ~1ms while a real
 * user's wrong password takes ~50ms of argon2 work — a timing oracle that lets
 * an attacker enumerate valid accounts. Doing the work either way removes the
 * signal. Generated once at boot from a random value.
 */
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hash(randomUUID(), PASSWORD_HASH_PARAMS);
  return dummyHashPromise;
}

@Injectable()
export class AuthService {
  private readonly clock: Clock = systemClock;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly tokens: TokenService,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  private get prisma(): PrismaClient {
    return this.prismaService.client;
  }

  async register(email: string, password: string): Promise<IssuedSession> {
    const normalized = normalizeEmail(email);
    const passwordHash = await hash(password, PASSWORD_HASH_PARAMS);

    try {
      const user = await this.prisma.user.create({
        data: { email: normalized, passwordHash, role: UserRole.REVIEWER },
      });
      return await this.issueSession(user);
    } catch (error) {
      // Rely on the unique index rather than a check-then-insert, which would
      // race two concurrent registrations for the same address.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('An account with that email already exists');
      }
      throw error;
    }
  }

  async login(email: string, password: string): Promise<IssuedSession> {
    const normalized = normalizeEmail(email);
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    const passwordMatches = await verify(user?.passwordHash ?? (await dummyHash()), password);

    // One message for both "no such user" and "wrong password": distinguishing
    // them hands an attacker a free account-enumeration oracle.
    if (!user || !passwordMatches) {
      this.logger.warn({ email: normalized }, 'Failed login attempt');
      throw new AuthenticationError('Invalid email or password');
    }

    return this.issueSession(user);
  }

  /**
   * Rotates a refresh token, or detects that it has been replayed.
   *
   * The security-critical path. See the domain policy for why replay implies
   * compromise and why the whole family must die.
   */
  async refresh(presentedToken: string): Promise<IssuedSession> {
    const tokenHash = this.tokens.hashRefreshToken(presentedToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      // Either forged, or from a family we already revoked and pruned.
      throw new AuthenticationError('Invalid refresh token');
    }

    const outcome = evaluateRefreshToken(stored, this.clock.now());

    if (outcome.kind === 'REUSE_DETECTED') {
      await this.revokeFamily(stored.familyId);

      this.logger.error(
        {
          event: 'REFRESH_TOKEN_REUSE',
          userId: stored.userId,
          familyId: stored.familyId,
          reason: outcome.reason,
        },
        'Refresh token reuse detected — revoked entire token family',
      );

      throw new AuthenticationError('Session invalidated. Please sign in again.');
    }

    if (outcome.kind === 'EXPIRED') {
      throw new AuthenticationError('Session expired. Please sign in again.');
    }

    return this.issueSession(stored.user, stored.familyId, stored.id);
  }

  /** Revokes the presented token's whole family, so every device in that chain is signed out. */
  async logout(presentedToken: string | undefined): Promise<void> {
    if (!presentedToken) return;

    const tokenHash = this.tokens.hashRefreshToken(presentedToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    // Logging out with an unknown token is a no-op, never an error: the client
    // wants to end the session and it is already, effectively, ended.
    if (!stored) return;

    await this.revokeFamily(stored.familyId);
  }

  /**
   * Issues an access token plus a fresh refresh token.
   *
   * When rotating, the old token's revocation and the new token's creation
   * happen in one transaction. A crash between them would otherwise either
   * strand the user with no valid token, or leave the burnt token live.
   */
  private async issueSession(
    user: { id: string; email: string; role: UserRole },
    existingFamilyId?: string,
    rotatedFromId?: string,
  ): Promise<IssuedSession> {
    const now = this.clock.now();
    const familyId = existingFamilyId ?? randomUUID();

    const refreshToken = this.tokens.generateRefreshToken();
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    const expiresAt = refreshTokenExpiry(now, this.env.REFRESH_TOKEN_TTL_DAYS);

    await this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: { userId: user.id, tokenHash, familyId, expiresAt },
      });

      if (rotatedFromId) {
        await tx.refreshToken.update({
          where: { id: rotatedFromId },
          data: { revokedAt: now, replacedBy: created.id },
        });
      }
    });

    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    return {
      response: {
        accessToken: this.tokens.signAccessToken({
          sub: user.id,
          email: user.email,
          role: user.role,
        }),
        expiresIn: this.tokens.accessTokenTtlSeconds(),
        user: authenticatedUser,
      },
      refreshToken,
      refreshTokenExpiresAt: expiresAt,
    };
  }

  /** Marks every still-live token in the family as revoked. */
  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
  }
}
