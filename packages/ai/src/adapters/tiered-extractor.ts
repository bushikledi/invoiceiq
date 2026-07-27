import type {
  ExtractionRequest,
  ExtractionResponse,
  LlmExtractor,
} from '../ports/llm-extractor.js';

/**
 * Model tiering: start cheap, escalate only when cheap demonstrably fails.
 *
 * Almost every invoice is a table of numbers, and a Haiku-class model reads it
 * correctly for roughly a fifth of the price of a Sonnet-class one. Routing
 * everything to the strong model to protect against the minority that need it
 * means paying the premium on the majority that do not.
 *
 * The escalation trigger is a *schema* failure, not low confidence. That
 * distinction matters:
 *
 *   - A schema failure means the cheap model could not produce well-formed
 *     output. A stronger model plausibly can, so the retry has a reason to
 *     succeed where the previous attempt did not.
 *   - Low confidence means the extraction parsed but the numbers are doubtful.
 *     A stronger model might agree with the doubtful numbers just as
 *     confidently, and we would have paid twice to learn nothing. That case
 *     belongs to a human, which is what the review queue is for.
 *
 * Tier selection is derived purely from `request.attempt`, so this wrapper — like
 * every adapter behind the port — holds no per-extraction state and a single
 * shared instance is safe under concurrency.
 */
export interface ExtractorTier {
  /** Named for logs and for the escalation callback; the adapter reports the authoritative model. */
  readonly model: string;
  readonly extractor: LlmExtractor;
}

export interface TieredExtractorOptions {
  /**
   * Attempts to spend on a tier before escalating. The last tier absorbs every
   * remaining attempt, so a short tier list can never exhaust the ladder and
   * leave an attempt with nowhere to go.
   */
  readonly attemptsPerTier?: number;
  /** Fired on the first request that lands on a higher tier, for logging and metrics. */
  readonly onEscalate?: (info: { attempt: number; from: string; to: string }) => void;
}

const DEFAULT_ATTEMPTS_PER_TIER = 2;

export class TieredLlmExtractor implements LlmExtractor {
  private readonly tiers: readonly ExtractorTier[];
  private readonly attemptsPerTier: number;
  private readonly onEscalate: TieredExtractorOptions['onEscalate'];

  /**
   * The cheap tier: what attempt 1 will report, and therefore the only correct
   * cache key. Reporting the strongest tier would let a document that needed
   * escalation seed a cache entry claiming the cheap model produced it.
   */
  readonly modelId: string;

  constructor(tiers: readonly ExtractorTier[], options: TieredExtractorOptions = {}) {
    if (tiers.length === 0) {
      // A tierless tiering wrapper would silently accept every request and then
      // fail with an index error on the first one, far from the misconfiguration.
      throw new Error('TieredLlmExtractor requires at least one tier');
    }

    this.tiers = tiers;
    this.modelId = tiers[0]!.extractor.modelId;
    this.attemptsPerTier = options.attemptsPerTier ?? DEFAULT_ATTEMPTS_PER_TIER;
    this.onEscalate = options.onEscalate;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    const index = this.tierFor(request.attempt);
    const tier = this.tiers[index]!;

    // Only announce the *transition*, not every request on the upper tier — an
    // escalation is an event worth alerting on; being on tier 1 for the third
    // attempt in a row is the same event repeated.
    if (index > 0 && this.tierFor(request.attempt - 1) === index - 1) {
      this.onEscalate?.({
        attempt: request.attempt,
        from: this.tiers[index - 1]!.model,
        to: tier.model,
      });
    }

    return tier.extractor.extract(request);
  }

  /** Exposed for tests: the whole policy is this one line, so assert it directly. */
  tierFor(attempt: number): number {
    const raw = Math.floor((Math.max(1, attempt) - 1) / this.attemptsPerTier);
    return Math.min(raw, this.tiers.length - 1);
  }
}
