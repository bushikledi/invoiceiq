/**
 * Domain errors.
 *
 * These are for failures the *caller* must handle but that are awkward to
 * thread through a Result — chiefly anything that crosses a repository or
 * transaction boundary. Rule violations and schema failures still travel as
 * `Result` values; these are for "the requested thing does not exist" and
 * "that transition is not legal".
 *
 * Framework-free by construction: the HTTP status mapping lives in the API's
 * exception filter, so the domain never learns what an HTTP status is.
 */

export type DomainErrorKind =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION';

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;

  /** Structured context for logs. Must never contain secrets or PII. */
  readonly context: Readonly<Record<string, unknown>>;

  protected constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.context = Object.freeze({ ...context });

    // Without this, `instanceof` fails for subclasses when the code is
    // transpiled to ES5-era output — and the exception filter would fall
    // through to a 500 for every domain error.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends DomainError {
  readonly kind = 'NOT_FOUND' as const;

  constructor(resource: string, id?: string) {
    super(id ? `${resource} ${id} was not found` : `${resource} was not found`, { resource, id });
  }
}

export class ConflictError extends DomainError {
  readonly kind = 'CONFLICT' as const;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

/** A state machine transition that the domain forbids. */
export class IllegalTransitionError extends DomainError {
  readonly kind = 'ILLEGAL_TRANSITION' as const;

  constructor(
    readonly from: string,
    readonly to: string,
    entity = 'Document',
  ) {
    super(`${entity} cannot move from ${from} to ${to}`, { entity, from, to });
  }
}

export class ValidationError extends DomainError {
  readonly kind = 'VALIDATION' as const;

  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ path: string; message: string }> = [],
  ) {
    super(message, { issueCount: issues.length });
  }
}

export class AuthenticationError extends DomainError {
  readonly kind = 'AUTHENTICATION' as const;

  constructor(message = 'Authentication required') {
    super(message);
  }
}

export class AuthorizationError extends DomainError {
  readonly kind = 'AUTHORIZATION' as const;

  constructor(message = 'Not permitted') {
    super(message);
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;
