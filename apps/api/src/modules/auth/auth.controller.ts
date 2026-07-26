import { Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AuthResponseSchema,
  LoginRequestSchema,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  RegisterRequestSchema,
  type AuthResponse,
  type LogoutResponse,
} from '@invoiceiq/contracts';
import { AuthenticationError } from '@invoiceiq/domain';
import type { ApiEnv } from '@invoiceiq/config';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import { API_ENV } from '../../config/config.module.js';
import { AuthService, type IssuedSession } from './auth.service.js';
import { CurrentUser, Public } from './auth.decorators.js';
import type { AuthenticatedUser } from '@invoiceiq/contracts';
import { ZodBody } from '../../common/validation/zod-validation.pipe.js';

/**
 * Auth endpoints.
 *
 * All are @Public() — they are how a caller *becomes* authenticated — and all
 * carry a far tighter rate limit than the global one, because these are the
 * routes worth brute-forcing.
 */
@Controller('auth')
@Public()
@Throttle({ auth: { limit: 10, ttl: 60_000 } })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @ZodBody(RegisterRequestSchema) body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const session = await this.auth.register(body.email, body.password);
    this.setRefreshCookie(res, session);
    return AuthResponseSchema.parse(session.response);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @ZodBody(LoginRequestSchema) body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const session = await this.auth.login(body.email, body.password);
    this.setRefreshCookie(res, session);
    return AuthResponseSchema.parse(session.response);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const presented = readRefreshCookie(req);
    if (!presented) {
      throw new AuthenticationError('Missing refresh token');
    }

    try {
      const session = await this.auth.refresh(presented);
      this.setRefreshCookie(res, session);
      return AuthResponseSchema.parse(session.response);
    } catch (error) {
      // The cookie is dead either way; clearing it stops the browser replaying
      // it and tripping reuse detection on every subsequent request.
      this.clearRefreshCookie(res);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoutResponse> {
    await this.auth.logout(readRefreshCookie(req));
    this.clearRefreshCookie(res);
    return { success: true };
  }

  /**
   * The current user, per the access token.
   *
   * The frontend calls this on load to rehydrate session state: the access
   * token lives only in memory, so after a page refresh the client has a
   * cookie but no user object. Overrides the controller-level @Public().
   */
  @Get('me')
  @Public(false)
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  private setRefreshCookie(res: Response, session: IssuedSession): void {
    res.cookie(REFRESH_COOKIE_NAME, session.refreshToken, {
      ...this.cookieOptions(),
      expires: session.refreshTokenExpiresAt,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE_NAME, this.cookieOptions());
  }

  private cookieOptions() {
    return {
      // Unreadable from JavaScript, so XSS cannot exfiltrate the session.
      httpOnly: true,
      // Not sent cross-site at all, which is what makes a separate CSRF token
      // unnecessary for these endpoints.
      sameSite: 'strict' as const,
      // Required in production; relaxed locally because dev runs over plain HTTP.
      secure: this.env.NODE_ENV === 'production',
      path: REFRESH_COOKIE_PATH,
    };
  }
}

function readRefreshCookie(req: Request): string | undefined {
  // cookie-parser types `req.cookies` as `any`, which would silently propagate
  // an untyped value into the auth path. Narrowing it here keeps the rest of
  // the flow honestly typed.
  const cookies: unknown = req.cookies;
  if (typeof cookies !== 'object' || cookies === null) return undefined;

  const value = (cookies as Record<string, unknown>)[REFRESH_COOKIE_NAME];
  return typeof value === 'string' ? value : undefined;
}
