import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from '../ports/embedding-provider.js';

/**
 * Hash-based embeddings for tests.
 *
 * Deliberately not semantic. Its value is that the same text always produces
 * the same vector, with no model download, no network, and no drift between
 * runs — which is what lets an integration test assert an exact result
 * ordering rather than "something plausible came back".
 *
 * The construction is a bag-of-words hash: each token is hashed into a
 * dimension and accumulated, then the vector is L2-normalised. That gives one
 * property real embeddings have and pure random vectors do not — texts sharing
 * words score higher against each other than texts that share none — which is
 * enough to test that ranking works without pretending to test meaning.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'deterministic-hash-v1';

  constructor(readonly dimensions: number = 384) {}

  embed(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.embedOne(text)));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);

    const tokens = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);

    for (const token of tokens) {
      const digest = createHash('sha256').update(token).digest();

      // Two dimensions per token, with signs from the hash, so distinct tokens
      // are unlikely to cancel each other out.
      const a = digest.readUInt32BE(0) % this.dimensions;
      const b = digest.readUInt32BE(4) % this.dimensions;
      // `noUncheckedIndexedAccess` widens these reads to `| undefined`; both
      // indices are provably in range, so the fallback is unreachable.
      vector[a] = (vector[a] ?? 0) + (digest[8]! % 2 === 0 ? 1 : -1);
      vector[b] = (vector[b] ?? 0) + (digest[9]! % 2 === 0 ? 0.5 : -0.5);
    }

    return normalise(vector);
  }
}

/**
 * L2-normalises in place.
 *
 * Cosine distance is undefined for a zero vector, and pgvector returns NaN
 * rather than erroring — which would sort unpredictably. Empty text falls back
 * to a fixed unit vector so it is merely irrelevant rather than corrupting.
 */
function normalise(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (magnitude === 0) {
    const fallback = new Array<number>(vector.length).fill(0);
    fallback[0] = 1;
    return fallback;
  }

  return vector.map((value) => value / magnitude);
}
