import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticationError, AuthorizationError } from '@invoiceiq/domain';
import type { AuthenticatedUser } from '@invoiceiq/contracts';
import { IS_PUBLIC_KEY, ROLES_KEY, type RequestWithUser } from './auth.decorators.js';
import { TokenService } from './token.service.js';

/**
 * Global authentication guard: every route is protected unless explicitly
 * marked @Public().
 *
 * Also enforces @Roles() in the same pass, since role checks are meaningless
 * without an authenticated principal and splitting them across two guards
 * invites an ordering bug.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new AuthenticationError('Missing bearer token');
    }

    let claims;
    try {
      claims = this.tokens.verifyAccessToken(token);
    } catch {
      // Never echo the underlying jsonwebtoken message: "jwt expired" vs
      // "invalid signature" tells an attacker which half of the token to work on.
      throw new AuthenticationError('Invalid or expired access token');
    }

    const user: AuthenticatedUser = {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
    };
    request.user = user;

    const requiredRoles = this.reflector.getAllAndOverride<AuthenticatedUser['role'][]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles?.length && !requiredRoles.includes(user.role)) {
      throw new AuthorizationError(`Requires role: ${requiredRoles.join(' or ')}`);
    }

    return true;
  }
}

/** Parses `Authorization: Bearer <token>`, case-insensitively on the scheme. */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}
