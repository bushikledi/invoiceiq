import { z } from 'zod';

/**
 * Auth wire format.
 *
 * These schemas are the single source of truth: the API validates requests
 * with them, and the frontend derives its client types from the same objects
 * via z.infer. A field cannot drift between the two.
 *
 * The refresh token is deliberately absent from every shape here — it travels
 * only as an httpOnly cookie, so JavaScript can never read it and XSS cannot
 * exfiltrate it.
 */

export const UserRoleSchema = z.enum(['REVIEWER', 'ADMIN']);
export type UserRole = z.infer<typeof UserRoleSchema>;

/** Minimum length matches MIN_PASSWORD_LENGTH in the domain's password policy. */
export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256, 'Password must be at most 256 characters');

export const EmailSchema = z
  .email('Must be a valid email address')
  .max(254, 'Email must be at most 254 characters');

export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: EmailSchema,
  // Not PasswordSchema: rejecting a short password at login with a *validation*
  // error would tell an attacker their guess was malformed rather than wrong,
  // and would lock out users whose password predates a policy change.
  password: z.string().min(1, 'Password is required'),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthenticatedUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: UserRoleSchema,
});
export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;

export const AuthResponseSchema = z.object({
  /** Short-lived JWT. Held in memory by the client — never localStorage. */
  accessToken: z.string(),
  /** Seconds until the access token expires, so the client can pre-emptively refresh. */
  expiresIn: z.number().int().positive(),
  user: AuthenticatedUserSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const LogoutResponseSchema = z.object({
  success: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

/** Name of the httpOnly refresh cookie. Shared so the web app's proxy route agrees. */
export const REFRESH_COOKIE_NAME = 'iq_refresh';

/**
 * Scoping the cookie to the auth path means it is not attached to every API
 * request, which shrinks both the CSRF surface and the chance of it being
 * logged by an intermediary.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
