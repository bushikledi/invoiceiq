import type { DocumentDetail, ExtractionDetail, FieldScore } from '@invoiceiq/contracts';
import type {
  Document,
  DocumentEvent,
  Extraction,
  Prisma,
  ValidationFinding,
} from '@invoiceiq/database';

type DocumentWithRelations = Document & {
  extractions: (Extraction & { findings: ValidationFinding[] })[];
  events: DocumentEvent[];
};

/**
 * Maps Prisma rows to the wire format.
 *
 * The mapper exists so raw Prisma types never escape the persistence layer.
 * That indirection is what lets the ORM change without touching the frontend,
 * and it is also where the two genuine impedance mismatches get handled:
 * Decimal (which serialises as a string and would silently become "0.973" in
 * the UI) and BigInt (which JSON.stringify throws on outright).
 */
export function toDocumentDetail(document: DocumentWithRelations): DocumentDetail {
  const latest = document.extractions[0];

  return {
    id: document.id,
    status: document.status,
    originalName: document.originalName,
    sizeBytes: document.sizeBytes,
    pageCount: document.pageCount,
    failureReason: document.failureReason,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    extraction: latest ? toExtractionDetail(latest) : null,
    events: document.events.map((event) => ({
      // BigInt would make JSON.stringify throw; the id is an opaque handle to
      // the client anyway.
      id: String(event.id),
      type: event.type,
      payload: (event.payload ?? {}) as Record<string, unknown>,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

function toExtractionDetail(
  extraction: Extraction & { findings: ValidationFinding[] },
): ExtractionDetail {
  return {
    id: extraction.id,
    version: extraction.version,
    data: extraction.data as ExtractionDetail['data'],
    fieldMeta: (extraction.fieldMeta ?? {}) as Record<string, FieldScore>,
    // Prisma Decimal serialises as a string. Sending it raw would make every
    // numeric comparison in the UI a string comparison, silently.
    overallConfidence: decimalToNumber(extraction.overallConfidence),
    model: extraction.model,
    promptVersion: extraction.promptVersion,
    attempts: extraction.attempts,
    inputTokens: extraction.inputTokens,
    outputTokens: extraction.outputTokens,
    costUsd: decimalToNumber(extraction.costUsd),
    createdAt: extraction.createdAt.toISOString(),
    findings: extraction.findings.map((finding) => ({
      id: String(finding.id),
      rule: finding.rule,
      severity: finding.severity,
      fieldPath: finding.fieldPath,
      message: finding.message,
      resolvedAt: finding.resolvedAt?.toISOString() ?? null,
    })),
  };
}

function decimalToNumber(value: Prisma.Decimal): number {
  return Number(value.toString());
}
