/**
 * The embedding seam.
 *
 * Three implementations sit behind this, and the choice is a real trade-off
 * rather than a preference:
 *
 *   local          multilingual MiniLM in-process. No API key, genuinely
 *                  semantic, handles the Italian invoices. Costs a ~120 MB
 *                  model download once and some CPU per document.
 *   openai         text-embedding-3-small. Better quality, needs a key and
 *                  a network round trip, and uses 1536 dimensions.
 *   deterministic  hash-based vectors. Not semantic at all — but stable,
 *                  instant, and dependency-free, which is what integration
 *                  tests need to assert an exact result ordering.
 *
 * Dimensionality is part of the contract because the pgvector column is
 * declared at a fixed width: swapping providers is a migration, not a config
 * change, and the adapter says so at boot rather than failing on the first
 * insert.
 */

export interface EmbeddingProvider {
  /** Vector width. Must match the `vector(N)` column. */
  readonly dimensions: number;
  /** Recorded on chunks so a later provider change is auditable. */
  readonly model: string;

  /**
   * Embeds a batch.
   *
   * Batched rather than one-at-a-time because a document produces many chunks,
   * and both the HTTP providers and the local model are far more efficient per
   * item when given several at once.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export class EmbeddingDimensionError extends Error {
  constructor(expected: number, actual: number, model: string) {
    super(
      `Embedding model "${model}" returned ${actual} dimensions but the database column ` +
        `expects ${expected}. Change EMBEDDING_PROVIDER back, or migrate the ` +
        `document_chunks.embedding column to vector(${actual}).`,
    );
    this.name = 'EmbeddingDimensionError';
    Object.setPrototypeOf(this, EmbeddingDimensionError.prototype);
  }
}

/** Formats a vector as a pgvector literal: `[0.1,0.2,…]`. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
