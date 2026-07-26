import type { z } from 'zod';
import { InvoiceExtractionSchema, type InvoiceExtraction } from '@invoiceiq/domain';
import { err, ok, type Result } from '@invoiceiq/domain';
import type { ExtractionRequest, LlmExtractor, TokenUsage } from './ports/llm-extractor.js';

/**
 * Structured output with a corrective retry loop.
 *
 * Layered defence, because each layer catches what the previous one cannot:
 *
 *   1. The provider's native structured-output mode constrains generation to
 *      the schema. It is very good and still not a guarantee.
 *   2. Zod re-validates the reply. Never trust, always verify — strict mode
 *      cannot express "totalCents must be an integer" the way Zod does, and it
 *      says nothing at all about cross-field semantics.
 *   3. On a parse failure we do not simply retry. Retrying an identical prompt
 *      at temperature 0 tends to reproduce an identical failure. Instead the
 *      *specific* Zod issues are fed back as feedback, so the model is told
 *      exactly which field was wrong and why.
 *
 * The distinction between this loop and BullMQ's retries matters: BullMQ
 * handles transient infrastructure failures (429, 5xx, socket resets) by
 * re-running the whole job later. This loop handles semantic failures inside a
 * single attempt. Conflating them would mean a malformed reply waits five
 * minutes for a backoff it does not need, and a rate-limit error burns all
 * three schema attempts instantly.
 */

export interface ExtractSuccess {
  readonly data: InvoiceExtraction;
  /** How many LLM calls it took. 1 means it parsed first time. */
  readonly attempts: number;
  /** Cumulative across every attempt — we pay for the failures too. */
  readonly usage: TokenUsage;
  readonly model: string;
}

export type ExtractFailure =
  | {
      readonly kind: 'SCHEMA_FAILURE';
      readonly attempts: number;
      /** Every issue from the final attempt, for the failure_reason column. */
      readonly issues: readonly string[];
      readonly usage: TokenUsage;
    }
  | {
      readonly kind: 'PROVIDER_ERROR';
      readonly attempts: number;
      readonly message: string;
      readonly retriable: boolean;
      readonly usage: TokenUsage;
    };

export interface RepairOptions {
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  /** Called on each failed attempt so the worker can write an LLM_RETRY event. */
  readonly onRetry?: (info: { attempt: number; issues: readonly string[] }) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export async function extractWithRepair(
  extractor: LlmExtractor,
  text: string,
  schema: Record<string, unknown>,
  options: RepairOptions = {},
): Promise<Result<ExtractSuccess, ExtractFailure>> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let feedback: string | undefined;
  let lastIssues: string[] = [];
  const usage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };
  let model = 'unknown';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const request: ExtractionRequest = {
      text,
      schema,
      attempt,
      ...(feedback === undefined ? {} : { feedback }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };

    let response;
    try {
      response = await extractor.extract(request);
    } catch (error) {
      // Provider failures are not schema failures: there is nothing to repair,
      // so the loop stops immediately and lets the queue decide whether to
      // retry the whole job.
      const retriable = isRetriable(error);
      return err({
        kind: 'PROVIDER_ERROR',
        attempts: attempt,
        message: error instanceof Error ? error.message : String(error),
        retriable,
        usage,
      });
    }

    // Accumulate before checking success — a failed attempt still costs money,
    // and under-reporting spend would make the cost dashboard a comfortable lie.
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    model = response.model;

    const parsed = InvoiceExtractionSchema.safeParse(response.raw);

    if (parsed.success) {
      return ok({ data: parsed.data, attempts: attempt, usage, model });
    }

    lastIssues = renderZodIssues(parsed.error, response.raw);
    options.onRetry?.({ attempt, issues: lastIssues });

    // No point building feedback we will never send.
    if (attempt < maxAttempts) {
      feedback = buildFeedback(lastIssues);
    }
  }

  return err({
    kind: 'SCHEMA_FAILURE',
    attempts: maxAttempts,
    issues: lastIssues,
    usage,
  });
}

/**
 * Turns Zod issues into instructions a model can act on.
 *
 * "Invalid input" tells the model nothing. "lineItems[1].totalCents: expected
 * an integer number of cents, received 12.5" tells it exactly which value to
 * change and how — which is why the second attempt usually succeeds.
 */
export function renderZodIssues(error: z.ZodError, raw?: unknown): string[] {
  return error.issues.map((issue) => {
    const path = formatPath(issue.path);
    const location = path === '' ? 'the response' : path;

    // Zod's own message already reads well and names the expected type — and
    // for our custom messages (e.g. "must be integer minor units") it is far
    // better than anything reconstructed from the issue code.
    const base = issue.message;

    // Zod 4 does not expose the offending value on the issue, so it is looked
    // up from the payload by path instead. Depending on a library internal
    // here would break silently on a minor version bump.
    const received = raw === undefined ? undefined : describeValue(valueAtPath(raw, issue.path));

    return received === undefined
      ? `${location}: ${base}`
      : `${location}: ${base} (received ${received})`;
  });
}

/** Walks a Zod issue path into the raw payload. */
function valueAtPath(raw: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = raw;

  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }

  return current;
}

function describeValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return `"${truncate(value, 40)}"`;
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return 'an object';
}

/** Formats a Zod path, preserving array indices: `lineItems[2].totalCents`. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc === '' ? String(segment) : `${acc}.${String(segment)}`;
  }, '');
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Wraps the issues in an instruction.
 *
 * Deliberately terse: this is prepended to a prompt we already pay for by the
 * token, and a long apology adds cost without improving the correction.
 */
export function buildFeedback(issues: readonly string[]): string {
  const list = issues.map((issue) => `- ${issue}`).join('\n');
  return [
    'Your previous response did not match the required schema.',
    'Fix exactly these problems and return the corrected JSON:',
    list,
    'Do not change any value that was not listed above.',
  ].join('\n');
}

function isRetriable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retriable' in error) {
    return Boolean(error.retriable);
  }
  // Unknown failures are assumed transient: retrying a permanent error costs a
  // few wasted attempts, whereas giving up on a transient one loses a document.
  return true;
}
