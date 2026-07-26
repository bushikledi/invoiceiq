import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, PASSWORD_HASH_PARAMS, normalizeEmail } from './password-policy.js';

describe('password policy', () => {
  describe('PASSWORD_HASH_PARAMS', () => {
    it('meets current OWASP argon2id guidance', () => {
      // Pinned as a test rather than a comment: if someone weakens these to
      // speed up a slow test suite, CI says so.
      expect(PASSWORD_HASH_PARAMS.memoryCost).toBeGreaterThanOrEqual(19456);
      expect(PASSWORD_HASH_PARAMS.timeCost).toBeGreaterThanOrEqual(2);
      expect(PASSWORD_HASH_PARAMS.parallelism).toBeGreaterThanOrEqual(1);
    });
  });

  describe('MIN_PASSWORD_LENGTH', () => {
    it('is a length floor of at least 12', () => {
      expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
    });
  });

  describe('normalizeEmail', () => {
    it('lowercases', () => {
      expect(normalizeEmail('Demo@InvoiceIQ.dev')).toBe('demo@invoiceiq.dev');
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeEmail('  demo@invoiceiq.dev  ')).toBe('demo@invoiceiq.dev');
    });

    it('handles both together', () => {
      expect(normalizeEmail('\t DEMO@Invoiceiq.DEV \n')).toBe('demo@invoiceiq.dev');
    });

    it('is idempotent', () => {
      const once = normalizeEmail(' User@Example.COM ');
      expect(normalizeEmail(once)).toBe(once);
    });

    it('leaves an already-normalised address unchanged', () => {
      expect(normalizeEmail('demo@invoiceiq.dev')).toBe('demo@invoiceiq.dev');
    });

    it('does not touch the local part beyond case', () => {
      // Dots and plus-addressing are significant to some providers; stripping
      // them here would silently merge distinct accounts.
      expect(normalizeEmail('First.Last+invoices@Example.com')).toBe(
        'first.last+invoices@example.com',
      );
    });
  });
});
