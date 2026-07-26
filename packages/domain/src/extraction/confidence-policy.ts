import {
  CRITICAL_FIELD_PATHS,
  EXPECTED_FIELD_PATHS,
  type InvoiceExtraction,
} from './invoice-schema.js';
import {
  buildSourceIndex,
  corroboratesAmount,
  corroboratesDate,
  corroboratesString,
  type SourceIndex,
} from './corroboration.js';

/**
 * Confidence scoring.
 *
 * Three independent signals are combined with `min`, not an average, because
 * they are each capable of independently condemning a field. A total the model
 * is 99% sure about but which appears nowhere in the document is not 65%
 * trustworthy — it is untrustworthy, and averaging would launder exactly the
 * failure we most need to catch.
 *
 *   selfReport     what the model claims          (uncalibrated, but not useless)
 *   presence       did we get a value at all      (null on an expected field is a miss)
 *   corroboration  does the value appear in the PDF (deterministic hallucination check)
 */

/** Below this, a field is flagged for human review. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

/** Score for an expected field that came back null. */
const MISSING_EXPECTED_SCORE = 0.4;

/** Score for a field whose value does not appear in the source text. */
const UNCORROBORATED_SCORE = 0.5;

/** Assumed self-report when the model omits a field from fieldConfidence. */
const ABSENT_SELF_REPORT = 0.5;

/** Critical fields count double in the overall score. */
const CRITICAL_WEIGHT = 2;
const STANDARD_WEIGHT = 1;

export interface FieldScore {
  readonly path: string;
  readonly score: number;
  readonly flagged: boolean;
  readonly selfReport: number;
  readonly presence: number;
  readonly corroboration: number;
  /** Why this field lost points, for the reviewer's tooltip. */
  readonly reason: string | null;
}

export interface ConfidenceAssessment {
  readonly fields: Readonly<Record<string, FieldScore>>;
  readonly overall: number;
  readonly flaggedPaths: readonly string[];
  /** True when anything needs a human before this can be auto-approved. */
  readonly requiresReview: boolean;
}

export interface ConfidenceOptions {
  readonly threshold?: number;
  /**
   * Raw text extracted from the PDF. When absent or empty, corroboration is
   * skipped entirely rather than scored as failure — with no text to search,
   * every field would look hallucinated and the whole document would be
   * flagged for reasons that say nothing about the extraction.
   */
  readonly sourceText?: string;
}

interface FieldSpec {
  path: string;
  /** null means the model reported the field as absent. */
  value: string | number | null;
  kind: 'amount' | 'date' | 'string';
  expected: boolean;
}

export function assessConfidence(
  extraction: InvoiceExtraction,
  options: ConfidenceOptions = {},
): ConfidenceAssessment {
  const threshold = options.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const index = buildSourceIndex(options.sourceText ?? '');

  const fields: Record<string, FieldScore> = {};
  for (const spec of describeFields(extraction)) {
    fields[spec.path] = scoreField(spec, extraction.fieldConfidence, index, threshold);
  }

  const scores = Object.values(fields);
  const flaggedPaths = scores.filter((f) => f.flagged).map((f) => f.path);

  return {
    fields,
    overall: weightedMean(scores),
    flaggedPaths,
    requiresReview: flaggedPaths.length > 0,
  };
}

function scoreField(
  spec: FieldSpec,
  selfReported: Record<string, number>,
  index: SourceIndex,
  threshold: number,
): FieldScore {
  const selfReport = selfReported[spec.path] ?? ABSENT_SELF_REPORT;

  const presence = spec.value === null && spec.expected ? MISSING_EXPECTED_SCORE : 1;

  const corroboration = scoreCorroboration(spec, index);

  const score = Math.min(selfReport, presence, corroboration);

  return {
    path: spec.path,
    score,
    flagged: score < threshold,
    selfReport,
    presence,
    corroboration,
    reason: explain({ selfReport, presence, corroboration, score, threshold }),
  };
}

function scoreCorroboration(spec: FieldSpec, index: SourceIndex): number {
  // No source text means no evidence either way. Scoring this as failure would
  // flag every field of every document whose text we could not extract.
  if (index.isEmpty) return 1;
  if (spec.value === null) return 1;

  const found =
    spec.kind === 'amount'
      ? corroboratesAmount(spec.value as number, index.amounts)
      : spec.kind === 'date'
        ? corroboratesDate(String(spec.value), index.normalizedText)
        : corroboratesString(String(spec.value), index.normalizedText);

  return found ? 1 : UNCORROBORATED_SCORE;
}

function explain(input: {
  selfReport: number;
  presence: number;
  corroboration: number;
  score: number;
  threshold: number;
}): string | null {
  if (input.score >= input.threshold) return null;

  // Name the signal that actually dominated, so the tooltip is actionable.
  if (input.presence <= input.score) return 'Field is missing from the document';
  if (input.corroboration <= input.score) return 'Value does not appear in the document text';
  return 'The model reported low confidence in this value';
}

/** Totals and VAT carry double weight: they are what an approver is accountable for. */
function weightedMean(scores: readonly FieldScore[]): number {
  if (scores.length === 0) return 1;

  let weighted = 0;
  let totalWeight = 0;

  for (const field of scores) {
    const weight = (CRITICAL_FIELD_PATHS as readonly string[]).includes(field.path)
      ? CRITICAL_WEIGHT
      : STANDARD_WEIGHT;
    weighted += field.score * weight;
    totalWeight += weight;
  }

  // Rounded to three decimals to match the NUMERIC(4,3) column and keep the
  // stored value stable across recomputation.
  return Math.round((weighted / totalWeight) * 1000) / 1000;
}

/** Flattens the extraction into the scalar fields worth scoring. */
function describeFields(extraction: InvoiceExtraction): FieldSpec[] {
  const expected = new Set<string>(EXPECTED_FIELD_PATHS);
  const isExpected = (path: string) => expected.has(path);

  const specs: FieldSpec[] = [
    { path: 'vendor.name', value: extraction.vendor.name, kind: 'string', expected: true },
    {
      path: 'vendor.vatNumber',
      value: extraction.vendor.vatNumber,
      kind: 'string',
      expected: false,
    },
    { path: 'vendor.address', value: extraction.vendor.address, kind: 'string', expected: false },
    {
      path: 'invoiceNumber',
      value: extraction.invoiceNumber,
      kind: 'string',
      expected: isExpected('invoiceNumber'),
    },
    { path: 'issueDate', value: extraction.issueDate, kind: 'date', expected: true },
    { path: 'dueDate', value: extraction.dueDate, kind: 'date', expected: false },
    // The currency code is rarely written literally as "EUR" — the symbol is
    // used instead — so corroborating it would produce noise. Treated as a
    // string field but almost always carried by self-report.
    { path: 'subtotalCents', value: extraction.subtotalCents, kind: 'amount', expected: true },
    { path: 'vatTotalCents', value: extraction.vatTotalCents, kind: 'amount', expected: true },
    { path: 'totalCents', value: extraction.totalCents, kind: 'amount', expected: true },
  ];

  extraction.lineItems.forEach((item, i) => {
    specs.push({
      path: `lineItems[${i}].totalCents`,
      value: item.totalCents,
      kind: 'amount',
      expected: true,
    });
    specs.push({
      path: `lineItems[${i}].description`,
      value: item.description,
      kind: 'string',
      expected: true,
    });
  });

  return specs;
}
