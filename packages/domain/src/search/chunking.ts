import { Money } from '../shared/money.js';
import type { InvoiceExtraction } from '../extraction/invoice-schema.js';

/**
 * Turning a document into searchable chunks.
 *
 * Two kinds are produced, and the second is the one that makes search useful:
 *
 * RAW chunks are windows over the PDF text. They preserve wording a user might
 * recall verbatim, and they are what lets a search hit a line buried in the
 * middle of a long invoice.
 *
 * The SYNTHETIC chunk is generated from the validated structured data — one
 * sentence naming the vendor, the city, the date, the total and every line item
 * together. This is what makes "chairs from the Milan vendor" work. In the raw
 * text those facts are scattered across a header, a table and a footer, so no
 * single window contains them all and no single embedding is close to the
 * query. Composing them into one coherent sentence puts the whole invoice in
 * one vector.
 */

/** Roughly four characters per token for European languages. */
const CHARS_PER_TOKEN = 4;

export const CHUNK_TOKENS = 500;
export const CHUNK_OVERLAP_TOKENS = 50;

export type ChunkKind = 'raw' | 'synthetic';

export interface DocumentChunk {
  readonly index: number;
  readonly kind: ChunkKind;
  readonly content: string;
}

/**
 * Splits text into overlapping windows.
 *
 * The overlap matters: a fact split across a boundary ("total for the Milan
 * office" ending one chunk, the amount starting the next) would be
 * unretrievable by either half. Overlapping means every span of roughly a
 * sentence appears intact in at least one chunk.
 *
 * Windows are cut at whitespace rather than mid-word, since a fragment like
 * "ufficio ergon" embeds to something meaningless.
 */
export function chunkText(
  text: string,
  tokensPerChunk = CHUNK_TOKENS,
  overlapTokens = CHUNK_OVERLAP_TOKENS,
): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '') return [];

  const size = tokensPerChunk * CHARS_PER_TOKEN;
  const overlap = overlapTokens * CHARS_PER_TOKEN;

  if (normalized.length <= size) return [normalized];

  const step = Math.max(size - overlap, 1);
  const chunks: string[] = [];

  for (let start = 0; start < normalized.length; start += step) {
    const end = Math.min(start + size, normalized.length);
    let slice = normalized.slice(start, end);

    // Trim to a word boundary unless this is the final window.
    if (end < normalized.length) {
      const lastSpace = slice.lastIndexOf(' ');
      if (lastSpace > size * 0.5) slice = slice.slice(0, lastSpace);
    }

    const trimmed = slice.trim();
    if (trimmed !== '') chunks.push(trimmed);

    if (end >= normalized.length) break;
  }

  return chunks;
}

/**
 * Builds the synthetic summary chunk from validated data.
 *
 * Written as prose rather than a field dump because embedding models are
 * trained on language: "Invoice INV-233 from ACME S.r.l. in Milano" sits much
 * closer to a natural-language query than "invoiceNumber=INV-233
 * vendor=ACME city=Milano" does.
 */
export function buildSyntheticChunk(extraction: InvoiceExtraction): string {
  const total = Money.of(extraction.totalCents, extraction.currency);

  /*
   * Ordered by semantic weight, deliberately.
   *
   * An earlier version opened with the invoice number and interleaved every
   * amount, VAT id and date. Measured against real queries that ranked badly:
   * "chairs from the Milan vendor" returned a London desk invoice first,
   * because a sentence that is 60% digits and identifiers embeds mostly as
   * noise, and what little signal remained was diluted.
   *
   * Identifiers and amounts are near-useless for *semantic* retrieval — nobody
   * searches by fuzzy resemblance to a VAT number — while being exactly what
   * the raw chunks and SQL filters already handle well. So the summary leads
   * with what a person would actually describe: who, where, and what was
   * bought. The reference data trails at the end where it cannot dominate.
   */
  const meaning: string[] = [
    extraction.vendor.name,
    extraction.vendor.address ?? '',
    // Descriptions repeated without quantities or prices around them: the
    // words are the signal.
    extraction.lineItems.map((item) => item.description).join(', '),
  ];

  const reference: string[] = [
    `Invoice ${extraction.invoiceNumber}`,
    `dated ${extraction.issueDate}`,
    `total ${total.format()}`,
  ];

  return (
    [...meaning.filter(Boolean), ...reference]
      .join('. ')
      // Vendor names routinely end in a period ("ACME S.r.l."), which the join
      // would turn into "S.r.l.. Via Roma". The snippet is shown verbatim in
      // search results, so this is user-visible.
      .replace(/\.\s*\./g, '.')
      .replace(/\s+/g, ' ')
      .trim() + '.'
  );
}

/**
 * Produces every chunk for a document.
 *
 * The synthetic chunk goes first, at index 0, so it is trivially identifiable
 * later — and because when several chunks of one document tie on similarity,
 * the summary is the one worth showing a user.
 */
export function buildChunks(rawText: string, extraction: InvoiceExtraction): DocumentChunk[] {
  const chunks: DocumentChunk[] = [
    { index: 0, kind: 'synthetic', content: buildSyntheticChunk(extraction) },
  ];

  chunkText(rawText).forEach((content, i) => {
    chunks.push({ index: i + 1, kind: 'raw', content });
  });

  return chunks;
}
