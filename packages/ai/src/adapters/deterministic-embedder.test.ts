import { describe, expect, it } from 'vitest';
import { DeterministicEmbeddingProvider } from './deterministic-embedder.js';

const embedder = new DeterministicEmbeddingProvider(384);

const cosine = (a: number[], b: number[]): number =>
  a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);

describe('DeterministicEmbeddingProvider', () => {
  it('produces vectors of the configured width', async () => {
    const [vector] = await embedder.embed(['an invoice']);
    expect(vector).toHaveLength(384);
  });

  it('is deterministic — the point of the whole adapter', async () => {
    // Integration tests assert an exact result ordering. That is only
    // meaningful if the same text always embeds identically.
    const [a] = await embedder.embed(['Sedie ufficio ergonomiche']);
    const [b] = await embedder.embed(['Sedie ufficio ergonomiche']);
    expect(a).toEqual(b);
  });

  it('returns unit vectors', async () => {
    const [vector] = await embedder.embed(['ACME S.r.l. Milano']);
    const magnitude = Math.sqrt(vector!.reduce((s, v) => s + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 6);
  });

  it('scores shared vocabulary above unrelated text', async () => {
    // Not semantic, but enough structure that ranking tests are testing
    // something rather than shuffling noise.
    const [chairs, chairsAgain, consulting] = await embedder.embed([
      'Sedie ufficio ergonomiche Milano',
      'Sedie ufficio Milano ACME',
      'Consulenza tecnica mensile Roma',
    ]);

    expect(cosine(chairs!, chairsAgain!)).toBeGreaterThan(cosine(chairs!, consulting!));
  });

  it('handles empty text without producing a zero vector', async () => {
    // Cosine distance against a zero vector is NaN, and pgvector sorts NaN
    // unpredictably rather than erroring.
    const [vector] = await embedder.embed(['']);
    const magnitude = Math.sqrt(vector!.reduce((s, v) => s + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 6);
    expect(vector!.some(Number.isNaN)).toBe(false);
  });

  it('handles punctuation-only text', async () => {
    const [vector] = await embedder.embed(['!!! ... ???']);
    expect(vector!.some(Number.isNaN)).toBe(false);
  });

  it('embeds a batch in order', async () => {
    const vectors = await embedder.embed(['first', 'second', 'third']);
    expect(vectors).toHaveLength(3);

    const [firstAlone] = await embedder.embed(['first']);
    expect(vectors[0]).toEqual(firstAlone);
  });

  it('returns nothing for an empty batch', async () => {
    expect(await embedder.embed([])).toEqual([]);
  });

  it('respects a different dimensionality', async () => {
    const wide = new DeterministicEmbeddingProvider(1536);
    const [vector] = await wide.embed(['text']);
    expect(vector).toHaveLength(1536);
  });

  it('is case-insensitive', async () => {
    const [upper] = await embedder.embed(['ACME MILANO']);
    const [lower] = await embedder.embed(['acme milano']);
    expect(upper).toEqual(lower);
  });

  it('ignores punctuation around a token', async () => {
    const [punctuated] = await embedder.embed(['ACME, Milano!']);
    const [plain] = await embedder.embed(['acme milano']);
    expect(punctuated).toEqual(plain);
  });

  it('does NOT equate differently-tokenised abbreviations', async () => {
    // "ACME S.r.l." splits to [acme, s, r, l] while "acme srl" gives
    // [acme, srl] — one shared token out of several. Worth pinning: this is
    // bag-of-words hashing, not a stemmer, and a test that expected otherwise
    // would be asserting a capability the adapter does not claim.
    const [dotted] = await embedder.embed(['ACME S.r.l.']);
    const [collapsed] = await embedder.embed(['acme srl']);
    expect(dotted).not.toEqual(collapsed);
    expect(cosine(dotted!, collapsed!)).toBeGreaterThan(0);
  });
});
