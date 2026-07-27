import { Injectable, Logger } from '@nestjs/common';
import { InvoiceExtractionSchema, systemClock, type InvoiceExtraction } from '@invoiceiq/domain';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';

/**
 * Never pay twice for the same bytes.
 *
 * The cache key is `(content_sha256, prompt_version, model)` — all three, because
 * changing any one of them changes the answer:
 *
 *   - **content_sha256** is the document. Two uploads of identical bytes cannot
 *     have different correct extractions.
 *   - **prompt_version** is the question. A reworded prompt is a different
 *     question, and reusing the old answer would make "did that prompt change
 *     improve quality?" unanswerable — the comparison rows would be copies of
 *     each other.
 *   - **model** is the answerer. Reusing Haiku's answer under a Sonnet
 *     configuration would record a Sonnet extraction that Sonnet never produced.
 *
 * ## What is cached, and what is not
 *
 * Only the **model output** — the fields, the token usage, the attempt count.
 * Validation, confidence scoring and chunking all re-run from scratch on a hit.
 *
 * That is the whole point. Those steps are pure, deterministic and free, and
 * they are also the steps most likely to have changed since the cached row was
 * written. Caching the *verdict* would mean a tightened business rule silently
 * did not apply to duplicate uploads — a cache that hides a bug fix. Caching
 * only the expensive, non-deterministic call means a hit exercises exactly the
 * same downstream code a miss does.
 *
 * ## Why this is not a cross-tenant read
 *
 * The lookup deliberately does not filter by uploader, which looks like a leak
 * and is not one. A hit requires byte-identical content, so the requesting user
 * already holds every byte the cached extraction was derived from — the
 * extraction is a pure function of bytes they uploaded themselves. Nothing
 * crosses a boundary except compute that would otherwise be repeated.
 *
 * The one thing that *would* leak is corrected data: a v2 extraction carries a
 * reviewer's judgement, not just the model's. So the lookup is pinned to
 * `version: 1`, which is also the only version that faithfully represents what
 * the model actually returned.
 */
export interface CachedExtraction {
  readonly data: InvoiceExtraction;
  readonly attempts: number;
  readonly usage: { inputTokens: number; outputTokens: number };
  readonly model: string;
  readonly sourceDocumentId: string;
}

@Injectable()
export class ExtractionCacheService {
  private readonly logger = new Logger(ExtractionCacheService.name);

  constructor(private readonly prismaService: PrismaService) {}

  async lookup(
    contentSha256: string,
    promptVersion: string,
    model: string,
  ): Promise<CachedExtraction | null> {
    const row = await this.prismaService.client.extraction.findFirst({
      where: {
        version: 1,
        promptVersion,
        model,
        document: { contentSha256 },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        documentId: true,
        data: true,
        attempts: true,
        inputTokens: true,
        outputTokens: true,
        model: true,
      },
    });

    if (!row) return null;

    // Re-parse rather than cast. A stored row predates any schema change made
    // since it was written, and feeding a stale shape into the pipeline would
    // surface as a confusing failure deep in scoring. A parse failure here just
    // means "cache miss", which is always a safe answer.
    const parsed = InvoiceExtractionSchema.safeParse(row.data);

    if (!parsed.success) {
      this.logger.warn(
        `Cached extraction ${row.documentId} no longer matches the schema — treating as a miss`,
      );
      return null;
    }

    return {
      data: parsed.data,
      attempts: row.attempts,
      usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
      model: row.model,
      sourceDocumentId: row.documentId,
    };
  }

  /**
   * Spend committed since midnight UTC, for the spend cap.
   *
   * UTC rather than a local calendar day: the worker, the database and the
   * provider's own billing period need not share a timezone, and a budget that
   * resets at a different hour than it is measured in is a budget nobody can
   * reason about.
   */
  async spentTodayUsd(): Promise<number> {
    const since = systemClock.now();
    since.setUTCHours(0, 0, 0, 0);

    const result = await this.prismaService.client.extraction.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { costUsd: true },
    });

    return result._sum.costUsd?.toNumber() ?? 0;
  }
}
