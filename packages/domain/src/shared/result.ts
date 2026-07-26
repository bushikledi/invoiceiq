/**
 * Expected failures are values, not exceptions.
 *
 * A business rule that fails, a schema that will not parse after three attempts,
 * an illegal state transition — these are all *anticipated outcomes* of a
 * correct program, so they travel through the type system where the compiler
 * forces the caller to handle them. Exceptions stay reserved for bugs and
 * genuine infrastructure faults (a dead socket, a full disk).
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;

/** Apply `fn` to a success value, leaving failures untouched. */
export const map = <T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> =>
  result.ok ? ok(fn(result.value)) : result;

/** Apply `fn` to a failure, leaving successes untouched. */
export const mapErr = <T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> =>
  result.ok ? result : err(fn(result.error));

/** Chain a fallible operation. */
export const andThen = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> => (result.ok ? fn(result.value) : result);

/** Extract the value or fall back. */
export const unwrapOr = <T, E>(result: Result<T, E>, fallback: T): T =>
  result.ok ? result.value : fallback;

/**
 * Extract the value or throw. Only for call sites that have already proven
 * success (tests, or a branch guarded by `isOk`) — never for control flow.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Called unwrap() on an Err: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** Collect a list of results into a result of a list, failing on the first error. */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
