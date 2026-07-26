import type { TokenUsage } from './ports/llm-extractor.js';

/**
 * Cost accounting.
 *
 * Every extraction records what it cost in USD. Without this, "how much does
 * this system spend" is answerable only by logging into a provider dashboard,
 * and per-document cost — the number that actually tells you whether the design
 * works — is not answerable at all.
 *
 * Prices are per million tokens. They change; when they do, historical rows
 * keep the cost computed at the time, which is the honest record.
 */
export interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },
  'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-5': { inputPerMillion: 15, outputPerMillion: 75 },
  // Fixtures cost nothing, and saying so keeps test assertions honest rather
  // than accumulating imaginary spend.
  'fixture-model': { inputPerMillion: 0, outputPerMillion: 0 },
};

/** Falls back to the default tier's price for an unknown model rather than zero. */
const FALLBACK: ModelPricing = { inputPerMillion: 1, outputPerMillion: 5 };

export function pricingFor(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? FALLBACK;
}

/**
 * Computes cost in USD, rounded to six decimal places to match the
 * NUMERIC(10,6) column. Sub-micro-dollar precision is not meaningful and would
 * only cause the stored value to differ from the recomputed one.
 */
export function computeCostUsd(usage: TokenUsage, model: string): number {
  const pricing = pricingFor(model);
  const cost =
    (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
