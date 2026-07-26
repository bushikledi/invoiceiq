/**
 * Money as integer minor units plus a currency code.
 *
 * Floats never touch money. `0.1 + 0.2 !== 0.3` in IEEE-754, and an invoice
 * pipeline that adds a hundred line items in floating point will disagree with
 * the vendor's own total by a cent often enough to matter — while looking
 * correct in every spot check. Storing cents as integers makes addition and
 * subtraction exact.
 *
 * The one place exactness is impossible is multiplication by a fractional
 * quantity (2.5 hours × €33.33), so rounding there is explicit and documented
 * rather than incidental.
 */

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`Cannot combine ${left} and ${right}: currencies must match`);
    this.name = 'CurrencyMismatchError';
  }
}

/** ISO-4217 alpha-3, uppercase. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    /** Minor units — cents for EUR/USD, but also whole yen for JPY. */
    readonly cents: number,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static of(cents: number, currency: string): Money {
    if (!Number.isInteger(cents)) {
      throw new Error(`Money requires integer minor units, received ${cents}`);
    }
    if (!Number.isSafeInteger(cents)) {
      // Beyond 2^53 arithmetic silently loses precision, which is the exact
      // failure this class exists to prevent.
      throw new Error(`Money amount ${cents} exceeds the safe integer range`);
    }
    const normalized = currency.toUpperCase();
    if (!CURRENCY_PATTERN.test(normalized)) {
      throw new Error(`Invalid currency code: "${currency}"`);
    }
    return new Money(cents, normalized);
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.cents + other.cents, this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.cents - other.cents, this.currency);
  }

  /**
   * Multiplies by a quantity or rate.
   *
   * Rounds half away from zero — the common commercial convention, and the one
   * most invoice software uses, so our recomputed line totals agree with the
   * vendor's more often than banker's rounding would.
   *
   * Note that `Math.round` is not this: it rounds half toward +Infinity, so
   * Math.round(-0.5) is -0 rather than -1, which would make credit notes
   * disagree with invoices by a cent.
   */
  times(factor: number): Money {
    if (!Number.isFinite(factor)) {
      throw new Error(`Cannot multiply money by ${factor}`);
    }
    const exact = this.cents * factor;
    return Money.of(roundHalfAwayFromZero(exact), this.currency);
  }

  /** Applies a percentage, e.g. a 22% VAT rate. */
  percentage(percent: number): Money {
    return this.times(percent / 100);
  }

  negated(): Money {
    return Money.of(-this.cents, this.currency);
  }

  abs(): Money {
    return Money.of(Math.abs(this.cents), this.currency);
  }

  equals(other: Money): boolean {
    return this.cents === other.cents && this.currency === other.currency;
  }

  /**
   * Equality within a tolerance.
   *
   * Every rounding-sensitive business rule uses this rather than strict
   * equality. A vendor rounding each line before summing can legitimately
   * differ from us by a cent per line, and flagging that for human review would
   * bury the reviewer in noise and hide the real errors.
   */
  withinTolerance(other: Money, toleranceCents: number): boolean {
    this.assertSameCurrency(other);
    if (toleranceCents < 0) {
      throw new Error(`Tolerance must be non-negative, received ${toleranceCents}`);
    }
    return Math.abs(this.cents - other.cents) <= toleranceCents;
  }

  isZero(): boolean {
    return this.cents === 0;
  }

  isNegative(): boolean {
    return this.cents < 0;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.cents < other.cents) return -1;
    if (this.cents > other.cents) return 1;
    return 0;
  }

  static sum(amounts: readonly Money[], currency: string): Money {
    return amounts.reduce((total, amount) => total.plus(amount), Money.zero(currency));
  }

  /** Human-readable, for findings shown to reviewers. */
  format(): string {
    const sign = this.cents < 0 ? '-' : '';
    const absolute = Math.abs(this.cents);
    const major = Math.floor(absolute / 100);
    const minor = String(absolute % 100).padStart(2, '0');
    return `${sign}${major}.${minor} ${this.currency}`;
  }

  toString(): string {
    return this.format();
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/**
 * Rounds to the nearest integer, with exact halves going away from zero.
 *
 * 2.5 → 3, -2.5 → -3 (Math.round would give -2).
 */
export function roundHalfAwayFromZero(value: number): number {
  // Floating-point multiplication can land a mathematically exact .5 a hair
  // below it (e.g. 1.005 * 100 = 100.49999999999999). Rounding to 10 significant
  // digits first recovers the intended value without affecting genuine cases.
  const corrected = Number(value.toPrecision(12));
  return corrected < 0 ? -Math.round(-corrected) : Math.round(corrected);
}
