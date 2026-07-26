import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '@invoiceiq/contracts';
import type { Request } from 'express';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of authentication.
 *
 * The guard is registered globally, so routes are private by default and
 * exposure is an explicit, greppable decision. The reverse — protection by
 * opt-in — means one forgotten decorator silently ships an open endpoint.
 */
export const Public = (isPublic = true): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, isPublic);

export const ROLES_KEY = 'roles';

/** Restricts a route to the given roles. Requires the JWT guard to have run. */
export const Roles = (...roles: AuthenticatedUser['role'][]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

/** Injects the authenticated user that JwtAuthGuard attached to the request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      // Reaching here means a controller asked for the user on a route that
      // never authenticated one — a wiring bug, not a client error.
      throw new Error('@CurrentUser() used on a route without JwtAuthGuard');
    }
    return request.user;
  },
);
