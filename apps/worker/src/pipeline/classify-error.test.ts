import { describe, expect, it } from 'vitest';
import { LlmError } from '@invoiceiq/ai';
import { classifyError } from './classify-error.js';
import { ScannedDocumentError, UnreadablePdfError, truncateForPrompt } from './pdf-text.js';

describe('classifyError', () => {
  describe('terminal failures', () => {
    it('treats a scanned document as terminal', () => {
      // A scan will still be a scan on the fourth attempt. Retrying only pays
      // to re-parse the same PDF.
      const result = classifyError(new ScannedDocumentError(3, 1));
      expect(result.kind).toBe('TERMINAL');
      expect(result).toMatchObject({ code: 'LIKELY_SCANNED_IMAGE' });
    });

    it('treats an unreadable PDF as terminal', () => {
      const result = classifyError(new UnreadablePdfError(new Error('bad xref')));
      expect(result.kind).toBe('TERMINAL');
      expect(result).toMatchObject({ code: 'UNREADABLE_PDF' });
    });

    it('treats a non-retriable LLM error as terminal', () => {
      const result = classifyError(new LlmError('400 Invalid request', false));
      expect(result.kind).toBe('TERMINAL');
    });
  });

  describe('retriable failures', () => {
    it('trusts the AI layer classification for a retriable LLM error', () => {
      // The AI layer already made this judgement from the HTTP status;
      // re-deriving it from the message string here would be a second, worse
      // implementation of the same decision.
      expect(classifyError(new LlmError('429 rate limited', true)).kind).toBe('RETRIABLE');
    });

    it.each([
      'connect ECONNREFUSED 127.0.0.1:5432',
      'read ECONNRESET',
      'socket hang up',
      'Connection terminated unexpectedly',
      'deadlock detected',
      'sorry, too many connections',
    ])('recognises the transient condition: %s', (message) => {
      expect(classifyError(new Error(message)).kind).toBe('RETRIABLE');
    });

    it('defaults an unknown error to retriable', () => {
      // Losing a document to an unrecognised transient fault is worse than
      // spending a bounded number of extra attempts finding out otherwise.
      expect(classifyError(new Error('something unexpected')).kind).toBe('RETRIABLE');
    });

    it('handles a thrown non-Error', () => {
      const result = classifyError('a bare string');
      expect(result.kind).toBe('RETRIABLE');
      expect(result.reason).toBe('a bare string');
    });
  });
});

describe('truncateForPrompt', () => {
  const pdf = (pages: string[]) => ({
    pages,
    text: pages.join('\n\n'),
    pageCount: pages.length,
  });

  it('returns short documents unchanged', () => {
    const doc = pdf(['a short invoice']);
    expect(truncateForPrompt(doc, 8_000)).toBe(doc.text);
  });

  it('keeps the first and last page when truncating a long document', () => {
    // Invoices put the vendor and number at the front and the totals at the
    // back. Head-only truncation would discard the totals — the single worst
    // thing to lose.
    const doc = pdf(['HEADER ACME INV-1', 'x'.repeat(50_000), 'y'.repeat(50_000), 'TOTAL 1234']);
    const result = truncateForPrompt(doc, 100);

    expect(result).toContain('HEADER');
    expect(result).toContain('TOTAL 1234');
    expect(result).toContain('omitted');
  });

  it('respects the token budget', () => {
    const doc = pdf(Array.from({ length: 10 }, () => 'z'.repeat(20_000)));
    const result = truncateForPrompt(doc, 1_000);
    // Four characters per token is an approximation, so allow some slack —
    // this is a spend guard, not an accounting figure.
    expect(result.length).toBeLessThanOrEqual(1_000 * 4 + 100);
  });

  it('falls back to head-and-tail when there are too few pages to drop', () => {
    const doc = pdf(['A'.repeat(30_000), 'B'.repeat(30_000)]);
    const result = truncateForPrompt(doc, 100);

    expect(result).toContain('truncated');
    expect(result.startsWith('A')).toBe(true);
    expect(result.endsWith('B')).toBe(true);
  });
});
