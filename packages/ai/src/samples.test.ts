import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { extractAmounts } from '@invoiceiq/domain';

/**
 * Asserts the generated sample PDFs are actually fit for purpose.
 *
 * The samples are the input to every downstream test and to the demo, so a
 * generator change that quietly stops producing extractable text — or produces
 * amounts that disagree with the fixtures — would invalidate a lot of green
 * checkmarks at once.
 */
const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples');

async function textOf(slug: string): Promise<{ text: string; pages: number }> {
  const bytes = await readFile(path.join(SAMPLES, `${slug}.pdf`));
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text, pages: totalPages };
}

describe('sample PDFs', () => {
  it('clean-invoice yields text containing the key fields', async () => {
    const { text } = await textOf('clean-invoice');
    expect(text).toContain('ACME');
    expect(text).toContain('INV-233');
    expect(text).toContain('12/03/2026');
    expect(text).toContain('IT12345678901');
  });

  it('clean-invoice amounts corroborate the fixture values', async () => {
    // This is the link that makes the fixtures meaningful: the numbers the
    // model "returns" must genuinely be present in the document it read.
    const { text } = await textOf('clean-invoice');
    const amounts = extractAmounts(text);

    expect(amounts.has(98_000)).toBe(true); // line 1 total 980,00
    expect(amounts.has(26_000)).toBe(true); // line 2 total 260,00
    expect(amounts.has(124_000)).toBe(true); // subtotal 1.240,00
    expect(amounts.has(27_280)).toBe(true); // VAT 272,80
    expect(amounts.has(151_280)).toBe(true); // total 1.512,80
  });

  it('sum-mismatch really does contain the inconsistent subtotal', async () => {
    const { text } = await textOf('sum-mismatch');
    const amounts = extractAmounts(text);

    expect(amounts.has(98_000)).toBe(true);
    expect(amounts.has(26_000)).toBe(true);
    // Lines total 1.240,00 but the document states 1.250,00.
    expect(amounts.has(125_000)).toBe(true);
  });

  it('long-multipage spans several pages', async () => {
    const { pages } = await textOf('long-multipage');
    expect(pages).toBeGreaterThan(1);
  });

  it('scanned-image yields essentially no text, so it can be rejected early', async () => {
    // The cost-control story depends on this: an image-only PDF must be
    // detected before it reaches the LLM, not after.
    const { text, pages } = await textOf('scanned-image');
    expect(text.trim().length / pages).toBeLessThan(50);
  });
});
