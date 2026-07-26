import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { assessConfidence, InvoiceExtractionSchema } from '@invoiceiq/domain';
import { FIXTURES, resolveScenarioFromText } from './fixtures/index.js';

/**
 * Every fixture must describe the PDF it is paired with.
 *
 * This exists because of a real bug found while clicking through the UI: the
 * sum-mismatch fixture carried the clean invoice's dates, which do not appear
 * anywhere in sum-mismatch.pdf. Corroboration did its job and flagged them —
 * so the review screen showed amber warnings on two fields that were perfectly
 * fine, and the demo looked broken while every unit test stayed green.
 *
 * Unit tests could not catch it: each fixture was internally consistent, and
 * each sample PDF was individually well-formed. Only checking the pair against
 * each other finds the disagreement.
 */
const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples');

async function textOf(slug: string): Promise<string> {
  const bytes = await readFile(path.join(SAMPLES, `${slug}.pdf`));
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/** Scenarios that have a matching sample PDF. */
const PAIRED = ['clean-invoice', 'sum-mismatch', 'missing-vat-number', 'multi-rate'] as const;

describe('fixtures agree with their sample PDFs', () => {
  it.each(PAIRED)('%s: no field claims a value the document lacks', async (slug) => {
    const text = await textOf(slug);
    const data = InvoiceExtractionSchema.parse(FIXTURES[slug]!.responses[0]);

    const confidence = assessConfidence(data, { sourceText: text });

    // Corroboration specifically, not `flagged` generally. A fixture may carry
    // a deliberately low self-report — missing-vat-number does, because the
    // model genuinely was unsure — and that is a signal we want, not a
    // disagreement between the fixture and its PDF. What must never happen is a
    // field asserting a value that appears nowhere in the document.
    const uncorroborated = Object.values(confidence.fields)
      .filter((field) => field.corroboration < 1)
      .map((field) => field.path);

    expect(uncorroborated).toEqual([]);
  });

  it.each(PAIRED)('%s: the scenario resolver picks the right fixture', async (slug) => {
    // Fixture mode selects a scenario from the document text. If this drifts,
    // uploading one sample silently returns another sample's extraction.
    expect(resolveScenarioFromText(await textOf(slug))).toBe(slug);
  });

  it('a scanned document matches no scenario, so it is never sent to the model', async () => {
    expect(resolveScenarioFromText(await textOf('scanned-image'))).toBeUndefined();
  });
});
