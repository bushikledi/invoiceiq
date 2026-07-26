/**
 * Time is an injected dependency.
 *
 * `DATE_SANITY` compares an invoice's issue date against "today". If the rule
 * reads the wall clock directly, its tests either pin the system clock or drift
 * into failure the moment a fixture ages past a boundary. Passing a Clock keeps
 * every date rule deterministic and lets tests sit exactly on the boundary.
 *
 * The base ESLint config bans bare `new Date()` outside presentation code to
 * keep this honest.
 */
export interface Clock {
  now(): Date;
}

/** Production clock. The single sanctioned call site for the real time. */
export const systemClock: Clock = {
  // eslint-disable-next-line no-restricted-syntax
  now: () => new Date(),
};

/** Test clock frozen at a fixed instant. */
export const fixedClock = (instant: Date | string): Clock => {
  const frozen = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(frozen.getTime())) {
    throw new Error(`fixedClock received an invalid instant: ${String(instant)}`);
  }
  return { now: () => new Date(frozen.getTime()) };
};
