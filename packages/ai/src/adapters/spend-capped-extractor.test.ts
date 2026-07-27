import { describe, expect, it, vi } from 'vitest';
import { SPEND_CAP_CODE, SpendCappedExtractor } from './spend-capped-extractor.js';
import { isLlmError } from '../ports/llm-extractor.js';
import type {
  ExtractionRequest,
  ExtractionResponse,
  LlmExtractor,
} from '../ports/llm-extractor.js';

const inner: LlmExtractor = {
  modelId: 'haiku',
  extract: (): Promise<ExtractionResponse> =>
    Promise.resolve({
      raw: { ok: true },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'haiku',
    }),
};

const request: ExtractionRequest = { text: 'invoice', schema: {}, attempt: 1 };

describe('SpendCappedExtractor', () => {
  it('passes the request through while under the cap', async () => {
    const extractor = new SpendCappedExtractor(inner, {
      capUsd: 5,
      spentUsd: () => Promise.resolve(4.99),
    });

    await expect(extractor.extract(request)).resolves.toMatchObject({ model: 'haiku' });
  });

  it('refuses once spend reaches the cap', async () => {
    const extractor = new SpendCappedExtractor(inner, {
      capUsd: 5,
      spentUsd: () => Promise.resolve(5),
    });

    await expect(extractor.extract(request)).rejects.toThrow(SPEND_CAP_CODE);
  });

  it('refuses without calling the provider — the point is not to spend the money', async () => {
    const spy = vi.fn();
    const extractor = new SpendCappedExtractor(
      { modelId: 'haiku', extract: spy },
      { capUsd: 1, spentUsd: () => Promise.resolve(10) },
    );

    await expect(extractor.extract(request)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('marks the refusal non-retriable so the queue does not re-check the same budget', async () => {
    const extractor = new SpendCappedExtractor(inner, {
      capUsd: 1,
      spentUsd: () => Promise.resolve(2),
    });

    const error = await extractor.extract(request).catch((e: unknown) => e);

    expect(isLlmError(error)).toBe(true);
    expect((error as { retriable: boolean }).retriable).toBe(false);
  });

  it('reports both figures, so the failure_reason says how far over we are', async () => {
    const extractor = new SpendCappedExtractor(inner, {
      capUsd: 2.5,
      spentUsd: () => Promise.resolve(3.125),
    });

    await expect(extractor.extract(request)).rejects.toThrow('$3.1250 of $2.50');
  });

  it('notifies on refusal so the breach is visible in metrics', async () => {
    const onRefuse = vi.fn();
    const extractor = new SpendCappedExtractor(inner, {
      capUsd: 1,
      spentUsd: () => Promise.resolve(4),
      onRefuse,
    });

    await expect(extractor.extract(request)).rejects.toThrow();
    expect(onRefuse).toHaveBeenCalledWith({ spentUsd: 4, capUsd: 1 });
  });

  it('does not read spend at all when the cap is disabled', async () => {
    const spentUsd = vi.fn(() => Promise.resolve(9_999));
    const extractor = new SpendCappedExtractor(inner, { capUsd: 0, spentUsd });

    await expect(extractor.extract(request)).resolves.toBeDefined();
    expect(spentUsd).not.toHaveBeenCalled();
  });
});
