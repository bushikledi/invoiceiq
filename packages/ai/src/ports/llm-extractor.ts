/**
 * The seam between our pipeline and whichever LLM is behind it.
 *
 * One narrow interface with three implementations — Anthropic, a fixture
 * replayer, and (M11) a tiering wrapper. That is what lets the entire
 * extraction pipeline run in CI with zero network and zero spend, and it is
 * the difference between "we tested the pipeline" and "we tested the pipeline
 * against a service that bills us and returns something different every time".
 *
 * The port deliberately knows nothing about invoices. It takes text and a JSON
 * Schema, and returns whatever the model produced plus what it cost. All
 * invoice semantics live in packages/domain; all retry and repair logic lives
 * one layer up in extractWithRepair.
 */

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ExtractionRequest {
  /** Text extracted from the PDF. Untrusted input — see the prompt-injection note. */
  readonly text: string;
  /** JSON Schema generated from the Zod schema, so the two cannot drift. */
  readonly schema: Record<string, unknown>;
  /**
   * Corrective feedback from a previous failed attempt: the specific Zod
   * issues, not "try again". Absent on the first attempt.
   */
  readonly feedback?: string;
  /**
   * 1-based attempt number within a single extraction.
   *
   * Carried on the request so adapters need no per-extraction state of their
   * own. That is what makes a shared adapter instance safe under concurrency —
   * and it is the signal the M11 model-tiering wrapper needs to escalate.
   */
  readonly attempt: number;
  /** Lets a long call be abandoned when the worker is draining. */
  readonly signal?: AbortSignal;
}

export interface ExtractionResponse {
  /** Unvalidated. The caller parses it against the Zod schema — never trust, always verify. */
  readonly raw: unknown;
  readonly usage: TokenUsage;
  readonly model: string;
}

export interface LlmExtractor {
  extract(request: ExtractionRequest): Promise<ExtractionResponse>;
}

/**
 * Errors the pipeline must distinguish.
 *
 * `retriable` is what separates "the provider is rate-limiting us, back off and
 * try again" from "this document will never parse, stop burning money on it".
 * Conflating the two either wastes spend on hopeless documents or gives up on
 * transient blips.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    // `cause` is a real member of Error since ES2022, so this genuinely
    // overrides rather than shadows it — keeping the standard field means
    // logging libraries that already understand error causes pick it up.
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
    Object.setPrototypeOf(this, LlmError.prototype);
  }
}

export const isLlmError = (error: unknown): error is LlmError => error instanceof LlmError;
