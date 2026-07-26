import Anthropic from '@anthropic-ai/sdk';
import { LlmError } from '../ports/llm-extractor.js';

/**
 * Classifies provider failures as retriable or terminal.
 *
 * Deliberately separate from the adapter that calls the network. This is pure
 * decision logic and the single most consequential branch in the AI layer:
 * misclassify a 429 as terminal and a rate limit silently fails documents;
 * misclassify a 401 as retriable and every document burns its full retry
 * budget re-sending a request that can never succeed, on every job, forever.
 *
 * Being a pure function, it is unit tested exhaustively. The adapter around it
 * is exercised by the nightly contract job against the real API, where the
 * thing worth checking is drift rather than branch coverage.
 */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;

  if (error instanceof Anthropic.APIError) {
    return new LlmError(
      `Anthropic API error ${error.status ?? 0}: ${error.message}`,
      // The SDK types `status` loosely; narrowing here keeps the classifier's
      // own signature honest.
      isRetriableStatus(typeof error.status === 'number' ? error.status : undefined),
      error,
    );
  }

  if (error instanceof Error && error.name === 'AbortError') {
    // The worker is draining. Retriable, so the job goes back to the queue and
    // a surviving worker picks it up rather than the document being failed for
    // what is really a deployment event.
    return new LlmError('Extraction aborted', true, error);
  }

  // Unknown failures are assumed transient. Wasting a few retries on a
  // permanent error is cheaper than losing a document to a transient one we
  // failed to recognise.
  return new LlmError(error instanceof Error ? error.message : String(error), true, error);
}

/**
 * 429 and 5xx are transient and worth retrying.
 *
 * 401/403 are misconfiguration — a missing or revoked key fails identically
 * forever. 400 means our own request is malformed, so retrying it just pays to
 * be told the same thing again. 404 means the model name is wrong.
 */
export function isRetriableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500;
}
