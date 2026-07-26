import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  ConflictError,
  InvoiceExtractionSchema,
  NotFoundError,
  ValidationError,
  assertTransition,
  assessConfidence,
  hasBlockingFinding,
  systemClock,
  validateInvoice,
  type Finding,
  type InvoiceExtraction,
} from '@invoiceiq/domain';
import type {
  Correction,
  DocumentDetail,
  ReviewRequest,
  ReviewResponse,
} from '@invoiceiq/contracts';
import { Prisma, type PrismaClient } from '@invoiceiq/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { applyCorrections } from './apply-corrections.js';
import { toDocumentDetail } from './document-detail.mapper.js';

@Injectable()
export class ReviewService {
  constructor(
    private readonly prismaService: PrismaService,
    @InjectPinoLogger(ReviewService.name) private readonly logger: PinoLogger,
  ) {}

  private get prisma(): PrismaClient {
    return this.prismaService.client;
  }

  /**
   * Everything the review screen needs, in one call.
   *
   * Only the latest extraction is returned. Earlier versions are kept for
   * model-quality analysis, but a reviewer looking at a document wants the
   * current state, not its history.
   */
  async detail(userId: string, documentId: string): Promise<DocumentDetail> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, uploaderId: userId },
      include: {
        extractions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { findings: { orderBy: { id: 'asc' } } },
        },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!document) throw new NotFoundError('Document', documentId);

    return toDocumentDetail(document);
  }

  /**
   * Submits a review decision.
   *
   * The critical property: corrections are re-validated **server-side** against
   * the same business rules the worker used. The client is not trusted to
   * decide that its own edit fixed the problem — a reviewer can mistype a
   * total, and a UI that accepts it because it rendered without a red border
   * would silently approve a wrong invoice for payment.
   *
   * If corrected data still fails an ERROR rule, the save is rejected with the
   * findings and the document stays in NEEDS_REVIEW.
   */
  async submit(
    userId: string,
    documentId: string,
    request: ReviewRequest,
  ): Promise<ReviewResponse> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, uploaderId: userId },
      include: { extractions: { orderBy: { version: 'desc' }, take: 1 } },
    });

    if (!document) throw new NotFoundError('Document', documentId);

    if (document.status !== 'NEEDS_REVIEW') {
      throw new ConflictError(
        `Only documents awaiting review can be reviewed; this one is ${document.status}`,
        { status: document.status },
      );
    }

    const latest = document.extractions[0];
    if (!latest) {
      // A NEEDS_REVIEW document without an extraction is a broken invariant,
      // not a user error.
      throw new ConflictError('Document has no extraction to review');
    }

    if (request.action === 'REJECTED') {
      return this.reject(userId, documentId, request.note ?? '');
    }

    const current = InvoiceExtractionSchema.parse(latest.data);
    const corrections = request.corrections ?? [];

    const corrected =
      corrections.length > 0 ? this.applyAndRevalidate(current, corrections) : current;

    const findings = validateInvoice(corrected, systemClock);

    // The backend is the authority. A correction that still breaks arithmetic
    // is not accepted just because the reviewer pressed approve.
    if (hasBlockingFinding(findings)) {
      throw new ValidationError(
        'The corrected data still fails validation',
        findings
          .filter((f) => f.severity === 'ERROR')
          .map((f) => ({ path: f.fieldPath ?? 'document', message: f.message })),
      );
    }

    return this.persistApproval({
      userId,
      documentId,
      action: corrections.length > 0 ? 'CORRECTED' : 'APPROVED',
      corrections,
      corrected,
      findings,
      previousVersion: latest.version,
      changed: corrections.length > 0,
    });
  }

  /** Applies corrections and re-parses, so a bad edit fails on shape before rules. */
  private applyAndRevalidate(
    current: InvoiceExtraction,
    corrections: readonly Correction[],
  ): InvoiceExtraction {
    const patched = applyCorrections(current, corrections);

    const parsed = InvoiceExtractionSchema.safeParse(patched);
    if (!parsed.success) {
      throw new ValidationError(
        'The correction produced an invalid invoice',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    return parsed.data;
  }

  private async persistApproval(input: {
    userId: string;
    documentId: string;
    action: 'APPROVED' | 'CORRECTED';
    corrections: readonly Correction[];
    corrected: InvoiceExtraction;
    findings: Finding[];
    previousVersion: number;
    changed: boolean;
  }): Promise<ReviewResponse> {
    const newVersion = input.changed ? input.previousVersion + 1 : null;

    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.document.findUniqueOrThrow({
        where: { id: input.documentId },
        select: { status: true },
      });
      assertTransition(fresh.status, 'COMPLETED');

      if (input.changed && newVersion !== null) {
        const previous = await tx.extraction.findFirstOrThrow({
          where: { documentId: input.documentId },
          orderBy: { version: 'desc' },
        });

        // Corrections create a new version rather than mutating the original.
        // Keeping v1 is what lets us ask later how often the model was wrong,
        // and about what — the whole point of storing confidence per field.
        const confidence = assessConfidence(input.corrected, { sourceText: '' });
        const humanMeta = Object.fromEntries(
          Object.entries(confidence.fields).map(([path, score]) => [
            path,
            {
              ...score,
              // A human said so. That is the highest-confidence source we have.
              source: input.corrections.some((c) => c.path === path) ? 'human' : 'llm',
              ...(input.corrections.some((c) => c.path === path)
                ? { score: 1, flagged: false, reason: null }
                : {}),
            },
          ]),
        );

        const created = await tx.extraction.create({
          data: {
            documentId: input.documentId,
            version: newVersion,
            data: toJson(input.corrected),
            fieldMeta: toJson(humanMeta),
            overallConfidence: new Prisma.Decimal(confidence.overall),
            model: previous.model,
            promptVersion: previous.promptVersion,
            attempts: previous.attempts,
            // The correction itself cost no tokens; attributing the original
            // spend twice would double-count it in the cost dashboard.
            inputTokens: 0,
            outputTokens: 0,
            costUsd: new Prisma.Decimal(0),
          },
        });

        if (input.findings.length > 0) {
          await tx.validationFinding.createMany({
            data: input.findings.map((finding) => ({
              extractionId: created.id,
              rule: finding.rule,
              severity: finding.severity,
              fieldPath: finding.fieldPath,
              message: finding.message,
            })),
          });
        }

        // The original findings are resolved, not deleted: the audit trail
        // should show that a problem existed and was addressed.
        await tx.validationFinding.updateMany({
          where: { extractionId: previous.id, resolvedAt: null },
          data: { resolvedAt: systemClock.now() },
        });
      }

      await tx.reviewDecision.create({
        data: {
          documentId: input.documentId,
          reviewerId: input.userId,
          action: input.action,
          corrections: input.changed ? toJson(input.corrections) : Prisma.JsonNull,
        },
      });

      await tx.document.update({
        where: { id: input.documentId },
        data: { status: 'COMPLETED' },
      });

      await tx.documentEvent.create({
        data: {
          documentId: input.documentId,
          type: 'REVIEW_SUBMITTED',
          payload: {
            from: 'NEEDS_REVIEW',
            to: 'COMPLETED',
            action: input.action,
            correctionCount: input.corrections.length,
            ...(newVersion === null ? {} : { newVersion }),
          },
        },
      });
    });

    this.logger.info(
      { documentId: input.documentId, action: input.action, newVersion },
      'Review submitted',
    );

    return {
      document: await this.detail(input.userId, input.documentId),
      newVersion,
    };
  }

  /** Rejection leaves the document in NEEDS_REVIEW; it is a decision, not a fix. */
  private async reject(userId: string, documentId: string, note: string): Promise<ReviewResponse> {
    await this.prisma.$transaction(async (tx) => {
      await tx.reviewDecision.create({
        data: {
          documentId,
          reviewerId: userId,
          action: 'REJECTED',
          corrections: Prisma.JsonNull,
        },
      });

      await tx.documentEvent.create({
        data: {
          documentId,
          type: 'REVIEW_REJECTED',
          payload: { note, status: 'NEEDS_REVIEW' },
        },
      });
    });

    return { document: await this.detail(userId, documentId), newVersion: null };
  }
}

/** See the note in the worker's processor — same reason, same one-line helper. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
