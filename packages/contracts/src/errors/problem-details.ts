import { z } from 'zod';

/**
 * One error envelope for the whole API, shaped after RFC 7807.
 *
 * A single response shape means the frontend has exactly one error branch to
 * write instead of one per endpoint, and `traceId` ties a user-visible failure
 * to the exact log line that produced it.
 */

export const ProblemTypes = [
  'validation_error',
  'authentication_error',
  'authorization_error',
  'not_found',
  'conflict',
  'illegal_state_transition',
  'rate_limited',
  'payload_too_large',
  'unsupported_media_type',
  'upstream_error',
  'internal_error',
] as const;

export type ProblemType = (typeof ProblemTypes)[number];

/** A single field-level failure, addressed by JSON path. */
export const FieldErrorSchema = z.object({
  /** Dotted/indexed path into the request body, e.g. `lineItems[2].totalCents`. */
  path: z.string(),
  message: z.string(),
});

export const ProblemDetailsSchema = z.object({
  /** Stable machine-readable discriminator. Clients branch on this, never on `title`. */
  type: z.enum(ProblemTypes),
  /** Short human summary. Safe to show a user. */
  title: z.string(),
  status: z.int().min(400).max(599),
  /** Longer explanation. Never contains a stack trace or internal detail. */
  detail: z.string().optional(),
  /** Present only for validation_error. */
  errors: z.array(FieldErrorSchema).optional(),
  /** Correlates this response with server logs. Always present. */
  traceId: z.string(),
});

export type FieldError = z.infer<typeof FieldErrorSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/** Default HTTP status for each problem type. */
export const PROBLEM_STATUS: Record<ProblemType, number> = {
  validation_error: 422,
  authentication_error: 401,
  authorization_error: 403,
  not_found: 404,
  conflict: 409,
  illegal_state_transition: 409,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  upstream_error: 502,
  internal_error: 500,
};

/** Default human-readable title for each problem type. */
export const PROBLEM_TITLE: Record<ProblemType, string> = {
  validation_error: 'Invalid payload',
  authentication_error: 'Authentication required',
  authorization_error: 'Not permitted',
  not_found: 'Not found',
  conflict: 'Conflict',
  illegal_state_transition: 'Illegal state transition',
  rate_limited: 'Too many requests',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  upstream_error: 'Upstream service failed',
  internal_error: 'Internal server error',
};

export interface BuildProblemInput {
  type: ProblemType;
  traceId: string;
  title?: string;
  detail?: string;
  status?: number;
  errors?: FieldError[];
}

/** Builds a well-formed envelope, filling status and title from the type. */
export function buildProblem({
  type,
  traceId,
  title,
  detail,
  status,
  errors,
}: BuildProblemInput): ProblemDetails {
  return {
    type,
    title: title ?? PROBLEM_TITLE[type],
    status: status ?? PROBLEM_STATUS[type],
    traceId,
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined ? {} : { errors }),
  };
}
