import { describe, expect, it } from 'vitest';
import { InvoiceExtractionSchema } from '@invoiceiq/domain';
import { AnthropicLlmExtractor } from './adapters/anthropic-extractor.js';
import { extractWithRepair } from './extract-with-repair.js';
import { invoiceJsonSchema } from './schema.js';
import { CLEAN_INVOICE_TEXT } from './fixtures/index.js';

/**
 * The contract test: does the real provider still behave the way the fixtures
 * claim?
 *
 * Every other test in this repository replaces the network call, which is what
 * makes them fast, free and deterministic — and is also their one blind spot.
 * A provider can deprecate a model, change how `tool_choice` is enforced,
 * rename a usage field or tighten JSON Schema validation, and every fixture
 * test stays green while production breaks. This is the test that would notice.
 *
 * ## Why it is not on the PR path
 *
 * It costs money and it is non-deterministic, which are the two properties that
 * make a test unfit to gate a merge: a flake blocks unrelated work, and a
 * contributor's typo fix should not bill anyone. It runs nightly instead, where
 * a failure opens an issue rather than blocking a person.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * It asserts the *shape of the contract*: a tool call comes back, it parses
 * against the schema, usage is reported, and the totals are internally
 * consistent. It does **not** assert specific field values. Asserting that the
 * model returns exactly `INV-233` would make the test a measure of model
 * behaviour rather than of the interface, and it would fail on a model upgrade
 * that was an improvement.
 */

const apiKey = process.env['ANTHROPIC_API_KEY'];
const model = process.env['LLM_MODEL'] ?? 'claude-haiku-4-5-20251001';

// Skipped, not failed, without a key. A developer running the whole suite on a
// laptop should not see a red test for declining to spend money.
const describeContract = apiKey ? describe : describe.skip;

describeContract('Anthropic contract (live)', () => {
  // The exact text the fixtures were recorded against, so a divergence is
  // attributable to the provider rather than to a different input.
  const text = CLEAN_INVOICE_TEXT;

  it('returns a tool call that parses against the current schema', async () => {
    const extractor = new AnthropicLlmExtractor({ apiKey: apiKey!, model });

    const result = await extractWithRepair(extractor, text, invoiceJsonSchema(), {
      maxAttempts: 2,
    });

    if (!result.ok) {
      // Fail with the provider's own words. "Expected true to be false" would
      // send whoever reads the nightly issue straight back to reproducing it.
      throw new Error(
        `Live extraction failed (${result.error.kind}): ${
          result.error.kind === 'SCHEMA_FAILURE'
            ? result.error.issues.join('; ')
            : result.error.message
        }`,
      );
    }

    expect(InvoiceExtractionSchema.safeParse(result.value.data).success).toBe(true);
  }, 120_000);

  it('reports token usage, which the cost accounting depends on', async () => {
    const extractor = new AnthropicLlmExtractor({ apiKey: apiKey!, model });

    const response = await extractor.extract({
      text,
      schema: invoiceJsonSchema(),
      attempt: 1,
    });

    // A silently-renamed usage field would make every recorded cost zero, and
    // zero is indistinguishable from "fixtures are free" on the dashboard.
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
    expect(response.model).toBeTruthy();
  }, 120_000);

  it('produces internally consistent totals', async () => {
    const extractor = new AnthropicLlmExtractor({ apiKey: apiKey!, model });

    const result = await extractWithRepair(extractor, text, invoiceJsonSchema(), {
      maxAttempts: 2,
    });

    if (!result.ok) throw new Error('Live extraction failed; see the previous test');

    const { subtotalCents, vatTotalCents, totalCents } = result.value.data;

    // A tolerance, not equality. Rounding on a multi-rate invoice legitimately
    // lands a cent either way, and a test that fails on that is a test that
    // gets muted.
    expect(Math.abs(subtotalCents + vatTotalCents - totalCents)).toBeLessThanOrEqual(2);
  }, 120_000);
});
