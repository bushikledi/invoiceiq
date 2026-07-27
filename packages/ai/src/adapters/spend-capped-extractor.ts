import {
  LlmError,
  type ExtractionRequest,
  type ExtractionResponse,
  type LlmExtractor,
} from '../ports/llm-extractor.js';

/**
 * A hard ceiling on spend, enforced in our own process.
 *
 * The provider console has a spend cap too, and it should be set. This is not a
 * duplicate of it: a provider cap protects the *bill*, some hours later, by
 * disabling the key for everything including the parts still working. This one
 * protects the *system* immediately, fails the affected documents with a reason
 * a human can read, and leaves everything else — search, review, export —
 * running.
 *
 * ## Two honest limitations
 *
 * **It overshoots by at most one extraction.** The cost of a call is not known
 * until the call returns, so the guard can only ask "are we already over?"
 * before dialling. Bounding overshoot exactly would mean predicting token
 * counts, which is guesswork dressed as precision. One extraction of slack on a
 * daily budget is the right trade.
 *
 * **It is a shared budget, not a per-tenant one.** With one tenant that is the
 * same thing. It stops being the same thing the moment `tenant_id` lands, and
 * at that point the reader must become tenant-scoped or one noisy tenant
 * silently starves everyone else.
 */
export interface SpendCapOptions {
  /** Ceiling in USD for the current window. Non-positive disables the guard entirely. */
  readonly capUsd: number;
  /**
   * Spend already committed in the current window, in USD.
   *
   * A function rather than a number because the authoritative figure lives in
   * the database, where it survives a worker restart. An in-memory counter
   * would reset the budget every deploy — which is exactly the moment a runaway
   * loop is most likely to be redeployed alongside its own fix.
   */
  readonly spentUsd: () => Promise<number>;
  /** Fired when a request is refused, so the refusal is visible in metrics rather than only in a failure_reason. */
  readonly onRefuse?: (info: { spentUsd: number; capUsd: number }) => void;
}

/** Machine-readable prefix, so "how often do we hit the cap?" is a query rather than a grep. */
export const SPEND_CAP_CODE = 'SPEND_CAP_EXCEEDED';

export class SpendCappedExtractor implements LlmExtractor {
  /** Delegated: a budget guard changes whether we call, never who answers. */
  readonly modelId: string;

  constructor(
    private readonly inner: LlmExtractor,
    private readonly options: SpendCapOptions,
  ) {
    this.modelId = inner.modelId;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    const { capUsd, spentUsd, onRefuse } = this.options;

    if (capUsd > 0) {
      const spent = await spentUsd();

      if (spent >= capUsd) {
        onRefuse?.({ spentUsd: spent, capUsd });

        // Deliberately NOT retriable. A cap breach is not a transient blip:
        // retrying with backoff would re-check the same budget minutes later,
        // still be over, and burn the job's remaining attempts to arrive at the
        // same answer. Failing now surfaces it to an operator, who can raise
        // the cap and requeue.
        throw new LlmError(
          `${SPEND_CAP_CODE}: $${spent.toFixed(4)} of $${capUsd.toFixed(2)} budget already spent`,
          false,
        );
      }
    }

    return this.inner.extract(request);
  }
}
