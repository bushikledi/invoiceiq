import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, Money, roundHalfAwayFromZero } from './money.js';

const eur = (cents: number) => Money.of(cents, 'EUR');

describe('Money', () => {
  describe('construction', () => {
    it('accepts integer minor units', () => {
      expect(eur(1250).cents).toBe(1250);
      expect(eur(0).cents).toBe(0);
      expect(eur(-500).cents).toBe(-500);
    });

    it('rejects fractional cents', () => {
      // A fractional cent means a float leaked in somewhere upstream — the
      // exact class of bug this type exists to prevent.
      expect(() => eur(12.5)).toThrowError(/integer minor units/);
    });

    it('rejects amounts beyond safe integer precision', () => {
      expect(() => eur(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    });

    it('normalises the currency code to uppercase', () => {
      expect(Money.of(100, 'eur').currency).toBe('EUR');
    });

    it.each(['EURO', 'E', '12A', ''])('rejects invalid currency %s', (code) => {
      expect(() => Money.of(100, code)).toThrowError(/Invalid currency/);
    });

    it('is immutable', () => {
      const money = eur(100);
      expect(Object.isFrozen(money)).toBe(true);
    });
  });

  describe('addition and subtraction are exact', () => {
    it('adds without floating-point drift', () => {
      // The canonical float failure: 0.1 + 0.2 !== 0.3. In cents it is exact.
      expect(eur(10).plus(eur(20)).cents).toBe(30);
    });

    it('stays exact across many additions', () => {
      // A hundred lines of 0.01 must be exactly 1.00, not 1.0000000000000007.
      const total = Money.sum(
        Array.from({ length: 100 }, () => eur(1)),
        'EUR',
      );
      expect(total.cents).toBe(100);
    });

    it('subtracts', () => {
      expect(eur(1000).minus(eur(250)).cents).toBe(750);
    });

    it('produces negative results where appropriate', () => {
      expect(eur(100).minus(eur(250)).cents).toBe(-150);
    });

    it('refuses to mix currencies', () => {
      // Silently adding USD to EUR would corrupt a total with no error at all.
      expect(() => eur(100).plus(Money.of(100, 'USD'))).toThrow(CurrencyMismatchError);
      expect(() => eur(100).minus(Money.of(100, 'USD'))).toThrow(CurrencyMismatchError);
    });

    it('returns a new instance rather than mutating', () => {
      const original = eur(100);
      original.plus(eur(50));
      expect(original.cents).toBe(100);
    });
  });

  describe('multiplication', () => {
    it('multiplies by a whole quantity', () => {
      expect(eur(1999).times(3).cents).toBe(5997);
    });

    it('multiplies by a fractional quantity, rounding half away from zero', () => {
      // 2.5 × €33.33 = €83.325 → €83.33
      expect(eur(3333).times(2.5).cents).toBe(8333);
    });

    it('rounds exact halves away from zero, not toward +Infinity', () => {
      // Math.round(-0.5) is -0, which would make a credit note disagree with
      // the invoice it reverses by one cent.
      expect(eur(1).times(0.5).cents).toBe(1);
      expect(eur(-1).times(0.5).cents).toBe(-1);
      expect(eur(5).times(0.5).cents).toBe(3);
      expect(eur(-5).times(0.5).cents).toBe(-3);
    });

    it('survives the classic float representation trap', () => {
      // 1.005 * 100 is 100.49999999999999 in IEEE-754; naive rounding gives 100.
      expect(roundHalfAwayFromZero(1.005 * 100)).toBe(101);
    });

    it('handles zero and identity', () => {
      expect(eur(1234).times(0).cents).toBe(0);
      expect(eur(1234).times(1).cents).toBe(1234);
    });

    it('rejects non-finite factors', () => {
      expect(() => eur(100).times(Number.NaN)).toThrow();
      expect(() => eur(100).times(Number.POSITIVE_INFINITY)).toThrow();
    });
  });

  describe('percentage', () => {
    it('computes a standard Italian VAT rate', () => {
      // 22% of €100.00 = €22.00
      expect(eur(10_000).percentage(22).cents).toBe(2200);
    });

    it('rounds a fractional VAT result', () => {
      // 22% of €12.34 = €2.7148 → €2.71
      expect(eur(1234).percentage(22).cents).toBe(271);
    });

    it('treats 0% as zero', () => {
      expect(eur(9999).percentage(0).isZero()).toBe(true);
    });
  });

  describe('tolerance comparison', () => {
    it('accepts a one-cent rounding difference', () => {
      // Vendors that round each line before summing legitimately differ from
      // us by a cent. Flagging that would bury reviewers in false positives.
      expect(eur(1000).withinTolerance(eur(1001), 1)).toBe(true);
      expect(eur(1000).withinTolerance(eur(999), 1)).toBe(true);
    });

    it('rejects a difference beyond tolerance', () => {
      expect(eur(1000).withinTolerance(eur(1002), 1)).toBe(false);
    });

    it('treats the tolerance boundary as inclusive', () => {
      expect(eur(1000).withinTolerance(eur(1005), 5)).toBe(true);
      expect(eur(1000).withinTolerance(eur(1006), 5)).toBe(false);
    });

    it('is symmetric', () => {
      expect(eur(1000).withinTolerance(eur(1003), 3)).toBe(eur(1003).withinTolerance(eur(1000), 3));
    });

    it('with zero tolerance is exact equality', () => {
      expect(eur(1000).withinTolerance(eur(1000), 0)).toBe(true);
      expect(eur(1000).withinTolerance(eur(1001), 0)).toBe(false);
    });

    it('rejects a negative tolerance', () => {
      expect(() => eur(1000).withinTolerance(eur(1000), -1)).toThrow();
    });

    it('refuses to compare across currencies', () => {
      expect(() => eur(100).withinTolerance(Money.of(100, 'USD'), 1)).toThrow(
        CurrencyMismatchError,
      );
    });
  });

  describe('comparison and predicates', () => {
    it('compares', () => {
      expect(eur(100).compare(eur(200))).toBe(-1);
      expect(eur(200).compare(eur(100))).toBe(1);
      expect(eur(100).compare(eur(100))).toBe(0);
    });

    it('reports equality including currency', () => {
      expect(eur(100).equals(eur(100))).toBe(true);
      expect(eur(100).equals(Money.of(100, 'USD'))).toBe(false);
    });

    it('identifies zero and negative amounts', () => {
      expect(Money.zero('EUR').isZero()).toBe(true);
      expect(eur(-1).isNegative()).toBe(true);
      expect(eur(0).isNegative()).toBe(false);
    });

    it('negates and takes absolute value', () => {
      expect(eur(-250).abs().cents).toBe(250);
      expect(eur(250).negated().cents).toBe(-250);
    });
  });

  describe('sum', () => {
    it('sums a list', () => {
      expect(Money.sum([eur(100), eur(250), eur(1)], 'EUR').cents).toBe(351);
    });

    it('returns zero for an empty list', () => {
      expect(Money.sum([], 'EUR').isZero()).toBe(true);
    });
  });

  describe('formatting', () => {
    it('renders major and minor units', () => {
      expect(eur(124050).format()).toBe('1240.50 EUR');
      expect(eur(5).format()).toBe('0.05 EUR');
      expect(eur(0).format()).toBe('0.00 EUR');
    });

    it('renders negatives with a single leading sign', () => {
      expect(eur(-124050).format()).toBe('-1240.50 EUR');
      expect(eur(-5).format()).toBe('-0.05 EUR');
    });
  });
});
