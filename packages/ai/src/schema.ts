import { z } from 'zod';
import { InvoiceExtractionSchema } from '@invoiceiq/domain';

/**
 * The JSON Schema handed to the provider, generated from the Zod schema.
 *
 * Generated, never hand-written. A hand-maintained copy drifts the first time
 * someone adds a field, and the failure mode is silent: the model is asked for
 * the old shape, returns it faithfully, and Zod rejects it — burning three
 * retries per document on a mistake that lives in a JSON file nobody reads.
 *
 * Zod 4 emits JSON Schema natively, so `zod-to-json-schema` is no longer a
 * dependency.
 */

/**
 * `io: 'input'` matters: our schema has a transform on `currency` (uppercasing),
 * so the input and output types differ. The provider must be given the *input*
 * shape, which is what it will actually produce.
 */
export function buildInvoiceJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(InvoiceExtractionSchema, {
    io: 'input',
    // Inline everything: providers vary in how well they follow $ref, and the
    // schema is small enough that the duplication costs a negligible number of
    // tokens compared to a tool call that silently ignores a reference.
    reused: 'inline',
  });
}

/** Cached — the schema is static and regenerating it per request is pure waste. */
let cached: Record<string, unknown> | undefined;

export function invoiceJsonSchema(): Record<string, unknown> {
  cached ??= buildInvoiceJsonSchema();
  return cached;
}
