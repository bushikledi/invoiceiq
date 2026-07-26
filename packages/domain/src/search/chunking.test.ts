import { describe, expect, it } from 'vitest';
import { CHUNK_OVERLAP_TOKENS, buildChunks, buildSyntheticChunk, chunkText } from './chunking.js';
import type { InvoiceExtraction } from '../extraction/invoice-schema.js';

const invoice = (overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction => ({
  vendor: { name: 'ACME S.r.l.', vatNumber: 'IT12345678901', address: 'Via Roma 1, Milano' },
  invoiceNumber: 'INV-233',
  issueDate: '2026-03-12',
  dueDate: '2026-04-11',
  currency: 'EUR',
  lineItems: [
    {
      description: 'Sedie ufficio ergonomiche',
      quantity: 4,
      unitPriceCents: 24_500,
      vatRatePercent: 22,
      totalCents: 98_000,
    },
  ],
  subtotalCents: 98_000,
  vatTotalCents: 21_560,
  totalCents: 119_560,
  fieldConfidence: {},
  ...overrides,
});

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('a short invoice')).toEqual(['a short invoice']);
  });

  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('normalises runs of whitespace', () => {
    // PDF text extraction produces ragged column spacing; embedding that
    // verbatim wastes tokens on nothing.
    expect(chunkText('a    b\n\n\nc')).toEqual(['a b c']);
  });

  it('splits long text into several chunks', () => {
    const chunks = chunkText('word '.repeat(2_000));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('overlaps consecutive chunks', () => {
    // A fact spanning a boundary would otherwise be unretrievable from either
    // side. The overlap guarantees it appears intact somewhere.
    const text = Array.from({ length: 900 }, (_, i) => `token${i}`).join(' ');
    const chunks = chunkText(text, 100, 20);

    expect(chunks.length).toBeGreaterThan(1);
    const tailOfFirst = chunks[0]!.split(' ').slice(-5);
    expect(tailOfFirst.some((word) => chunks[1]!.includes(word))).toBe(true);
  });

  it('never splits mid-word', () => {
    const text = Array.from({ length: 800 }, () => 'ergonomiche').join(' ');
    for (const chunk of chunkText(text, 100, 10)) {
      for (const word of chunk.split(' ')) {
        expect(word).toBe('ergonomiche');
      }
    }
  });

  it('covers the whole text', () => {
    const text = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    const joined = chunkText(text, 100, 20).join(' ');

    // Every original token must survive somewhere, or search silently cannot
    // find part of the document.
    for (const token of ['w0', 'w250', 'w499']) {
      expect(joined).toContain(token);
    }
  });

  it('terminates on text that is an exact multiple of the window', () => {
    // A step calculation that can reach zero would loop forever here.
    expect(() => chunkText('x'.repeat(400), 100, 50)).not.toThrow();
  });

  it('has a sane default overlap', () => {
    expect(CHUNK_OVERLAP_TOKENS).toBeGreaterThan(0);
  });
});

describe('buildSyntheticChunk', () => {
  it('leads with the semantically meaningful content', () => {
    const chunk = buildSyntheticChunk(invoice());

    // Ordering is load-bearing: identifiers and amounts embed as noise, so the
    // vendor, place and item descriptions come first where they dominate the
    // vector. Measured — the previous number-heavy phrasing returned a London
    // desk invoice for "chairs from the Milan vendor".
    const vendorAt = chunk.indexOf('ACME S.r.l.');
    const itemsAt = chunk.indexOf('Sedie ufficio ergonomiche');
    const invoiceNumberAt = chunk.indexOf('INV-233');

    expect(vendorAt).toBeGreaterThanOrEqual(0);
    expect(itemsAt).toBeGreaterThan(vendorAt);
    expect(invoiceNumberAt).toBeGreaterThan(itemsAt);
  });

  it('still carries the reference data, just not up front', () => {
    const chunk = buildSyntheticChunk(invoice());
    expect(chunk).toContain('INV-233');
    expect(chunk).toContain('2026-03-12');
  });

  /** The whole reason this chunk exists. */
  it('puts the vendor city and the item description in ONE chunk', () => {
    const chunk = buildSyntheticChunk(invoice());

    // In the raw PDF these are a header and a table row, pages apart in token
    // space. A query like "chairs from the Milan vendor" only matches when both
    // live in the same embedding.
    expect(chunk).toContain('Milano');
    expect(chunk).toContain('Sedie ufficio ergonomiche');
  });

  it('includes the formatted total', () => {
    expect(buildSyntheticChunk(invoice())).toContain('1195.60 EUR');
  });

  it('lists every line item', () => {
    const chunk = buildSyntheticChunk(
      invoice({
        lineItems: [
          {
            description: 'Sedie ufficio',
            quantity: 2,
            unitPriceCents: 10_000,
            vatRatePercent: 22,
            totalCents: 20_000,
          },
          {
            description: 'Scrivania regolabile',
            quantity: 1,
            unitPriceCents: 26_000,
            vatRatePercent: 22,
            totalCents: 26_000,
          },
        ],
      }),
    );

    expect(chunk).toContain('Sedie ufficio');
    expect(chunk).toContain('Scrivania regolabile');
  });

  it('omits absent optional fields rather than saying "null"', () => {
    const chunk = buildSyntheticChunk(
      invoice({
        vendor: { name: 'Bright Supplies Ltd', vatNumber: null, address: null },
        dueDate: null,
      }),
    );

    // "VAT number null" would embed as meaningful text and pollute the vector.
    expect(chunk).not.toContain('null');
    expect(chunk).not.toContain('undefined');
    expect(chunk).toContain('Bright Supplies Ltd');
  });

  it('produces no double spaces', () => {
    const chunk = buildSyntheticChunk(invoice({ dueDate: null }));
    expect(chunk).not.toMatch(/ {2}/);
  });

  it('does not double the period after a vendor name that ends in one', () => {
    // "ACME S.r.l." joined with ". " gives "S.r.l.. Via Roma". The snippet is
    // shown verbatim in search results, so this is user-visible.
    const chunk = buildSyntheticChunk(invoice());
    expect(chunk).not.toContain('..');
    expect(chunk).toContain('ACME S.r.l. Via Roma');
  });
});

describe('buildChunks', () => {
  it('puts the synthetic chunk first', () => {
    const chunks = buildChunks('some raw text', invoice());

    expect(chunks[0]!.kind).toBe('synthetic');
    expect(chunks[0]!.index).toBe(0);
  });

  it('numbers chunks contiguously from zero', () => {
    const chunks = buildChunks('word '.repeat(3_000), invoice());
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('still produces the synthetic chunk when there is no raw text', () => {
    // Even a document whose text extraction was thin remains findable by its
    // structured facts.
    const chunks = buildChunks('', invoice());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe('synthetic');
  });

  it('marks raw chunks as raw', () => {
    const chunks = buildChunks('some raw text', invoice());
    expect(chunks.slice(1).every((c) => c.kind === 'raw')).toBe(true);
  });
});
