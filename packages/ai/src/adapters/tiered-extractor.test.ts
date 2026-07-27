import { describe, expect, it, vi } from 'vitest';
import { TieredLlmExtractor, type ExtractorTier } from './tiered-extractor.js';
import type { ExtractionRequest, ExtractionResponse, LlmExtractor } from '../ports/llm-extractor.js';

/** Records which requests it saw and answers with its own name. */
class SpyExtractor implements LlmExtractor {
  readonly seen: number[] = [];

  constructor(private readonly model: string) {}

  get modelId(): string {
    return this.model;
  }

  extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    this.seen.push(request.attempt);
    return Promise.resolve({
      raw: { from: this.model },
      usage: { inputTokens: 10, outputTokens: 5 },
      model: this.model,
    });
  }
}

const tier = (model: string): ExtractorTier & { extractor: SpyExtractor } => ({
  model,
  extractor: new SpyExtractor(model),
});

const request = (attempt: number): ExtractionRequest => ({ text: 'invoice', schema: {}, attempt });

describe('TieredLlmExtractor', () => {
  it('spends the configured number of attempts on the cheap tier before escalating', async () => {
    const cheap = tier('haiku');
    const strong = tier('sonnet');
    const extractor = new TieredLlmExtractor([cheap, strong], { attemptsPerTier: 2 });

    await extractor.extract(request(1));
    await extractor.extract(request(2));
    await extractor.extract(request(3));

    expect(cheap.extractor.seen).toEqual([1, 2]);
    expect(strong.extractor.seen).toEqual([3]);
  });

  it('reports the tier that actually answered', async () => {
    const extractor = new TieredLlmExtractor([tier('haiku'), tier('sonnet')], {
      attemptsPerTier: 1,
    });

    await expect(extractor.extract(request(1))).resolves.toMatchObject({ model: 'haiku' });
    await expect(extractor.extract(request(2))).resolves.toMatchObject({ model: 'sonnet' });
  });

  it('pins every further attempt to the last tier rather than running off the end', async () => {
    const strong = tier('sonnet');
    const extractor = new TieredLlmExtractor([tier('haiku'), strong], { attemptsPerTier: 1 });

    await extractor.extract(request(2));
    await extractor.extract(request(3));
    await extractor.extract(request(9));

    expect(strong.extractor.seen).toEqual([2, 3, 9]);
  });

  it('announces an escalation once, not on every attempt at the upper tier', async () => {
    const onEscalate = vi.fn();
    const extractor = new TieredLlmExtractor([tier('haiku'), tier('sonnet')], {
      attemptsPerTier: 2,
      onEscalate,
    });

    await extractor.extract(request(3));
    await extractor.extract(request(4));

    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(onEscalate).toHaveBeenCalledWith({ attempt: 3, from: 'haiku', to: 'sonnet' });
  });

  it('never escalates when only one tier is configured', async () => {
    const onEscalate = vi.fn();
    const only = tier('haiku');
    const extractor = new TieredLlmExtractor([only], { attemptsPerTier: 1, onEscalate });

    await extractor.extract(request(1));
    await extractor.extract(request(5));

    expect(only.extractor.seen).toEqual([1, 5]);
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('rejects an empty tier list at construction, not on the first request', () => {
    expect(() => new TieredLlmExtractor([])).toThrow(/at least one tier/);
  });

  it('treats a zeroth attempt as the first rather than indexing below the cheap tier', () => {
    const extractor = new TieredLlmExtractor([tier('haiku'), tier('sonnet')]);
    expect(extractor.tierFor(0)).toBe(0);
    expect(extractor.tierFor(1)).toBe(0);
  });
});
