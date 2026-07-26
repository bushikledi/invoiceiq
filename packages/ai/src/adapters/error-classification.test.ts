import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../ports/llm-extractor.js';
import { isRetriableStatus, toLlmError } from './error-classification.js';

/** Builds a real SDK error so the classifier is tested against the actual type. */
const apiError = (status: number, message = 'boom') =>
  new Anthropic.APIError(status, { message }, message, new Headers());

describe('isRetriableStatus', () => {
  it('retries a rate limit', () => {
    // The single most important case: 429 is the provider asking us to wait,
    // not telling us the request is wrong.
    expect(isRetriableStatus(429)).toBe(true);
  });

  it.each([500, 502, 503, 504, 529])('retries server error %i', (status) => {
    expect(isRetriableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422])('does NOT retry client error %i', (status) => {
    // These fail identically forever. Retrying spends the document's whole
    // budget to be told the same thing three times.
    expect(isRetriableStatus(status)).toBe(false);
  });

  it('retries when the status is unknown', () => {
    // A network-level failure has no status. Losing a document to an
    // unrecognised transient error is worse than a couple of wasted attempts.
    expect(isRetriableStatus(undefined)).toBe(true);
  });
});

describe('toLlmError', () => {
  it('passes an LlmError through unchanged', () => {
    const original = new LlmError('already classified', false);
    expect(toLlmError(original)).toBe(original);
  });

  it('classifies a 429 as retriable and keeps the status in the message', () => {
    const error = toLlmError(apiError(429, 'rate limit exceeded'));

    expect(error).toBeInstanceOf(LlmError);
    expect(error.retriable).toBe(true);
    expect(error.message).toContain('429');
    expect(error.message).toContain('rate limit exceeded');
  });

  it('classifies a 401 as terminal', () => {
    // A revoked key must not be retried on every job forever.
    expect(toLlmError(apiError(401, 'invalid x-api-key')).retriable).toBe(false);
  });

  it('classifies a 400 as terminal', () => {
    expect(toLlmError(apiError(400, 'schema too large')).retriable).toBe(false);
  });

  it('classifies a 500 as retriable', () => {
    expect(toLlmError(apiError(500)).retriable).toBe(true);
  });

  it('treats an abort as retriable so a draining worker requeues the job', () => {
    // Shutdown is a deployment event, not a bad document.
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';

    const error = toLlmError(abort);
    expect(error.retriable).toBe(true);
    expect(error.message).toBe('Extraction aborted');
  });

  it('treats an unrecognised error as retriable', () => {
    expect(toLlmError(new Error('socket hang up')).retriable).toBe(true);
  });

  it('handles a thrown non-Error', () => {
    const error = toLlmError('something odd');
    expect(error.message).toBe('something odd');
    expect(error.retriable).toBe(true);
  });

  it('preserves the original error as the cause', () => {
    const original = apiError(500);
    expect(toLlmError(original).cause).toBe(original);
  });
});
