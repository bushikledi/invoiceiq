import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import {
  computeCostUsd,
  extractWithRepair,
  invoiceJsonSchema,
  PROMPT_VERSION,
  type LlmExtractor,
} from '@invoiceiq/ai';
import {
  assessConfidence,
  assertTransition,
  hasBlockingFinding,
  isOk,
  systemClock,
  validateInvoice,
  type DocumentStatus,
  type Finding,
  type InvoiceExtraction,
} from '@invoiceiq/domain';
import { Prisma, type PrismaClient } from '@invoiceiq/database';
import type { ExtractionOutcome } from '@invoiceiq/observability';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../config/config.module.js';
import { LLM_EXTRACTOR } from '../ai/llm.module.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { StorageService } from '../infrastructure/storage/storage.service.js';
import {
  JOB_EMBED_DOCUMENT,
  QUEUE_EMBEDDING,
  QUEUE_EXTRACTION,
  type ExtractDocumentJob,
} from '../queues.js';
import { extractPdfText, truncateForPrompt } from './pdf-text.js';
import { classifyError, TERMINAL_CODES } from './classify-error.js';
import { ExtractionCacheService } from './extraction-cache.service.js';
import { PipelineMetrics } from '../observability/pipeline.metrics.js';
import { DocumentEventsPublisher } from '../events/document-events.service.js';

/**
 * The extraction pipeline.
 *
 *   guard → PROCESSING → fetch → text → truncate → extract+repair
 *         → validate → score → persist (one transaction) → COMPLETED | NEEDS_REVIEW
 *
 * Two properties are worth stating explicitly, because everything else depends
 * on them:
 *
 * IDEMPOTENCY. The job id is the document id, so BullMQ refuses a duplicate
 * enqueue, and the status guard below refuses to process a document that is not
 * QUEUED. Together they mean "the enqueue succeeded but the HTTP response was
 * lost" is a non-event rather than a double LLM bill.
 *
 * ATOMICITY. The extraction, its findings and the status transition are written
 * in a single transaction. Splitting them would allow a crash to leave a
 * document COMPLETED with no extraction attached, or an extraction with no
 * status — states nothing downstream knows how to interpret.
 */
@Processor(QUEUE_EXTRACTION, { concurrency: 2 })
export class ExtractDocumentProcessor extends WorkerHost {
  private readonly logger = new Logger(ExtractDocumentProcessor.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly storage: StorageService,
    @Inject(LLM_EXTRACTOR) private readonly llm: LlmExtractor,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @InjectQueue(QUEUE_EMBEDDING) private readonly embeddingQueue: Queue,
    private readonly cache: ExtractionCacheService,
    private readonly metrics: PipelineMetrics,
    private readonly events: DocumentEventsPublisher,
  ) {
    super();
  }

  /**
   * Announces a committed status change.
   *
   * The uploader is read here rather than threaded through every call site,
   * because the publisher needs it for authorisation filtering on the API side
   * and forgetting it on one path would silently drop that document's events
   * for the user who owns it. One extra indexed read per transition is a fair
   * price for making that impossible.
   */
  private async announce(documentId: string, status: DocumentStatus): Promise<void> {
    try {
      const row = await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { uploaderId: true, failureReason: true },
      });

      if (!row) return;

      await this.events.publish({
        documentId,
        uploaderId: row.uploaderId,
        status,
        at: systemClock.now().toISOString(),
        failureReason: row.failureReason,
      });
    } catch (error) {
      // Best-effort by design — see DocumentEventsPublisher. The client's
      // polling fallback covers a dropped announcement.
      this.logger.warn(`Could not announce ${documentId} → ${status}: ${String(error)}`);
    }
  }

  private get prisma(): PrismaClient {
    return this.prismaService.client;
  }

  async process(job: Job<ExtractDocumentJob>): Promise<{ status: string }> {
    const { documentId, traceId } = job.data;
    const log = (message: string) => this.logger.log(`[${traceId}] ${documentId}: ${message}`);

    const document = await this.prisma.document.findUnique({ where: { id: documentId } });

    // Guard, not an error. A redelivered job for a document that has already
    // moved on is expected under at-least-once delivery, and treating it as a
    // failure would fill the dead-letter queue with successes.
    if (!document) {
      log('document no longer exists — acknowledging');
      return { status: 'SKIPPED_MISSING' };
    }
    if (document.status !== 'QUEUED') {
      log(`already ${document.status} — acknowledging without reprocessing`);
      return { status: 'SKIPPED_NOT_QUEUED' };
    }

    await this.transition(documentId, 'QUEUED', 'PROCESSING');

    const startedAt = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - startedAt) / 1e9;

    try {
      const result = await this.runPipeline(document, job);
      log(`finished as ${result.status}`);
      this.metrics.recordExtraction(outcomeLabel(result.status), elapsed(), result.cached === true);
      return result;
    } catch (error) {
      const failure = await this.handleFailure(documentId, error, job);
      this.metrics.recordExtraction(outcomeLabel(failure.status), elapsed(), false);
      return failure;
    }
  }

  private async runPipeline(
    document: { id: string; s3Key: string; contentSha256: string | null },
    job: Job<ExtractDocumentJob>,
  ): Promise<{ status: string; cached?: boolean }> {
    const documentId = document.id;
    const bytes = await this.storage.download(document.s3Key);

    // Early rejection. A scanned PDF would otherwise be sent to the model,
    // which would invent an entire invoice from nothing and bill us for it.
    const pdf = await extractPdfText(bytes);

    const promptText = truncateForPrompt(pdf, this.env.MAX_PROMPT_TOKENS);

    // The cache is consulted after the PDF is parsed, not before. Parsing is
    // cheap and local; the source text is needed either way, because
    // corroboration scores the extraction against *this* document's text rather
    // than against whatever the cached one contained.
    const cached = await this.lookupCache(document.contentSha256, documentId);

    let data: InvoiceExtraction;
    let attempts: number;
    let usage: { inputTokens: number; outputTokens: number };
    let model: string;

    if (cached) {
      ({ data, attempts, usage, model } = cached);
    } else {
      const extraction = await extractWithRepair(this.llm, promptText, invoiceJsonSchema(), {
        maxAttempts: this.env.MAX_EXTRACTION_ATTEMPTS,
        onRetry: ({ attempt, issues }) => {
          // Recorded as an event so a stuck document's history shows the model
          // was corrected, not merely that it was slow.
          void this.recordEvent(documentId, 'LLM_RETRY', { attempt, issues });
        },
      });

      if (!isOk(extraction)) {
        const failure = extraction.error;

        if (failure.kind === 'PROVIDER_ERROR' && failure.retriable) {
          // Hand the decision to the queue: it owns backoff.
          throw new RetriableProviderError(failure.message);
        }

        await this.failDocument(
          documentId,
          failure.kind === 'SCHEMA_FAILURE'
            ? `${TERMINAL_CODES.SCHEMA_FAILURE}: ${failure.issues.join('; ')}`
            : failure.message,
          { attempts: failure.attempts },
        );
        return { status: 'FAILED' };
      }

      ({ data, attempts, usage, model } = extraction.value);
    }

    const findings = validateInvoice(data, systemClock);
    const confidence = assessConfidence(data, {
      sourceText: pdf.text,
      threshold: this.env.CONFIDENCE_THRESHOLD,
    });

    // A rule failure forces review regardless of how confident the model was;
    // confidence alone can also force it. Either is sufficient.
    const needsReview = hasBlockingFinding(findings) || confidence.requiresReview;
    const nextStatus = needsReview ? 'NEEDS_REVIEW' : 'COMPLETED';

    const extractionId = await this.persist({
      documentId,
      data,
      findings,
      confidence,
      attempts,
      usage,
      model,
      pageCount: pdf.pageCount,
      nextStatus,
      jobId: job.id ?? documentId,
      // A cache hit is genuinely free: the tokens were paid for once, on the
      // original document. Charging them again would make cumulative spend a
      // number that grows without any money leaving the account, which is
      // exactly the kind of comfortable lie the cost dashboard exists to avoid.
      cached: cached !== null,
    });

    // Enqueued after the transaction commits, never inside it: a job that fires
    // on a transaction that then rolls back would try to embed an extraction
    // that does not exist.
    //
    // Failure to enqueue must not fail the extraction — the document is
    // correct, it is merely not searchable yet, and losing a good extraction
    // over a Redis blip would be the wrong trade.
    try {
      await this.embeddingQueue.add(
        JOB_EMBED_DOCUMENT,
        { documentId, extractionId, traceId: job.data.traceId },
        { jobId: extractionId },
      );
    } catch (error) {
      this.logger.warn(`${documentId}: could not enqueue embedding: ${String(error)}`);
    }

    return { status: nextStatus, cached: cached !== null };
  }

  /**
   * Cache lookup, with failure treated as a miss.
   *
   * The model is read from configuration rather than from the previous run,
   * because the question is "have we already asked *this* model *this* question
   * about *these* bytes?" — and the model we would be about to use is the one
   * that defines `this model`.
   */
  private async lookupCache(
    contentSha256: string | null,
    documentId: string,
  ): Promise<{
    data: InvoiceExtraction;
    attempts: number;
    usage: { inputTokens: number; outputTokens: number };
    model: string;
  } | null> {
    // The hash is written at /complete, so anything reaching this queue has one.
    // It is nullable in the schema all the same, and a cache keyed on "no hash"
    // would match every hashless document to every other — the one bug in a
    // cache that produces confidently wrong data rather than a slow miss.
    if (!this.env.EXTRACTION_CACHE_ENABLED || !contentSha256) return null;

    let hit;
    try {
      // The extractor's own identity, not `env.LLM_MODEL`. Under the fixture
      // provider those differ permanently, and keying on configuration would
      // make every lookup a miss — silently, since a cache that never hits is
      // indistinguishable from one with nothing to reuse.
      hit = await this.cache.lookup(contentSha256, PROMPT_VERSION, this.llm.modelId);
    } catch (error) {
      // A cache that is down must degrade to a slow, correct system rather than
      // a broken one. Falling through to the model costs money; failing the
      // document costs the user their upload.
      this.logger.warn(`${documentId}: cache lookup failed, extracting live: ${String(error)}`);
      return null;
    }

    this.metrics.recordCacheLookup(hit !== null);

    if (!hit) return null;

    this.logger.log(`${documentId}: reusing extraction from ${hit.sourceDocumentId} (same bytes)`);
    void this.recordEvent(documentId, 'EXTRACTION_CACHE_HIT', {
      sourceDocumentId: hit.sourceDocumentId,
      model: hit.model,
      promptVersion: PROMPT_VERSION,
    });

    return { data: hit.data, attempts: hit.attempts, usage: hit.usage, model: hit.model };
  }

  /**
   * Writes everything in one transaction.
   *
   * The status transition is asserted inside the transaction rather than
   * before it, so a concurrent writer cannot slip the document into another
   * state between the check and the write.
   */
  private async persist(input: {
    documentId: string;
    data: InvoiceExtraction;
    findings: Finding[];
    confidence: ReturnType<typeof assessConfidence>;
    attempts: number;
    usage: { inputTokens: number; outputTokens: number };
    model: string;
    pageCount: number;
    nextStatus: 'COMPLETED' | 'NEEDS_REVIEW';
    jobId: string;
    cached: boolean;
  }): Promise<string> {
    const costUsd = input.cached ? 0 : computeCostUsd(input.usage, input.model);

    this.metrics.recordSpend(input.model, costUsd, input.attempts);

    const extractionId = await this.prisma.$transaction(async (tx) => {
      const current = await tx.document.findUniqueOrThrow({
        where: { id: input.documentId },
        select: { status: true },
      });
      assertTransition(current.status, 'EXTRACTED');
      assertTransition('VALIDATING', input.nextStatus);

      const extraction = await tx.extraction.create({
        data: {
          documentId: input.documentId,
          version: 1,
          data: toJson(input.data),
          fieldMeta: toJson(input.confidence.fields),
          overallConfidence: new Prisma.Decimal(input.confidence.overall),
          model: input.model,
          promptVersion: PROMPT_VERSION,
          attempts: input.attempts,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          costUsd: new Prisma.Decimal(costUsd),
        },
      });

      if (input.findings.length > 0) {
        await tx.validationFinding.createMany({
          data: input.findings.map((finding) => ({
            extractionId: extraction.id,
            rule: finding.rule,
            severity: finding.severity,
            fieldPath: finding.fieldPath,
            message: finding.message,
          })),
        });
      }

      await tx.document.update({
        where: { id: input.documentId },
        data: { status: input.nextStatus, pageCount: input.pageCount },
      });

      await tx.documentEvent.create({
        data: {
          documentId: input.documentId,
          type: 'STATUS_CHANGED',
          payload: {
            from: 'PROCESSING',
            to: input.nextStatus,
            attempts: input.attempts,
            overallConfidence: input.confidence.overall,
            flaggedFields: input.confidence.flaggedPaths,
            findingCount: input.findings.length,
            costUsd,
            cached: input.cached,
          },
        },
      });

      return extraction.id;
    });

    await this.announce(input.documentId, input.nextStatus);

    return extractionId;
  }

  /** Decides between re-throwing for a retry and failing the document. */
  private async handleFailure(
    documentId: string,
    error: unknown,
    job: Job<ExtractDocumentJob>,
  ): Promise<{ status: string }> {
    const classification = classifyError(error);
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    if (classification.kind === 'RETRIABLE' && !isFinalAttempt) {
      // Back to QUEUED so the status guard lets the retry through — otherwise
      // the redelivered job would find PROCESSING and skip itself.
      await this.transition(documentId, 'PROCESSING', 'QUEUED', {
        reason: classification.reason,
        attempt: job.attemptsMade + 1,
      });
      throw error instanceof Error ? error : new Error(String(error));
    }

    // Prefix with the machine-readable code where we have one. The message
    // alone reads fine for a human but gives metrics nothing to group by, and
    // "how many documents fail because they are scans?" is exactly the question
    // that drives whether OCR is worth building.
    const reason =
      classification.kind === 'TERMINAL'
        ? `${classification.code}: ${classification.reason}`
        : classification.reason;

    await this.failDocument(documentId, reason, {
      retriable: classification.kind === 'RETRIABLE',
      ...(classification.kind === 'TERMINAL' ? { code: classification.code } : {}),
      attempts: job.attemptsMade + 1,
    });
    return { status: 'FAILED' };
  }

  private async failDocument(
    documentId: string,
    reason: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    // Truncated: failure_reason is shown in the UI and a full stack trace or a
    // hundred Zod issues would make the column unreadable.
    const trimmed = reason.length > 1_000 ? `${reason.slice(0, 1_000)}…` : reason;

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { status: true },
      });
      assertTransition(current.status, 'FAILED');

      await tx.document.update({
        where: { id: documentId },
        data: { status: 'FAILED', failureReason: trimmed },
      });
      await tx.documentEvent.create({
        data: {
          documentId,
          type: 'STATUS_CHANGED',
          payload: { from: current.status, to: 'FAILED', reason: trimmed, ...payload },
        },
      });
    });

    this.logger.warn(`${documentId} failed: ${trimmed}`);

    await this.announce(documentId, 'FAILED');
  }

  private async transition(
    documentId: string,
    from: 'QUEUED' | 'PROCESSING',
    to: 'PROCESSING' | 'QUEUED',
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    assertTransition(from, to);

    await this.prisma.$transaction(async (tx) => {
      await tx.document.update({ where: { id: documentId }, data: { status: to } });
      await tx.documentEvent.create({
        data: { documentId, type: 'STATUS_CHANGED', payload: { from, to, ...payload } },
      });
    });

    await this.announce(documentId, to);
  }

  private async recordEvent(
    documentId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.documentEvent.create({
        data: { documentId, type, payload: payload as Prisma.InputJsonValue },
      });
    } catch (error) {
      // An audit write must never take down the extraction it is describing.
      this.logger.warn(`Failed to record ${type} for ${documentId}: ${String(error)}`);
    }
  }
}

/**
 * The single sanctioned conversion from a domain object to a JSONB column.
 *
 * Prisma's `InputJsonValue` cannot be satisfied structurally by a TypeScript
 * interface — interfaces have no index signature — so assigning a domain type
 * directly is a compile error no matter how JSON-shaped it actually is. The
 * alternative is `as unknown as InputJsonValue` scattered at every call site,
 * which silences the checker without proving anything.
 *
 * Round-tripping through JSON both satisfies the type and does real work: it
 * strips `undefined` (which Prisma rejects at runtime) and guarantees what we
 * store is genuinely serialisable rather than merely assumed to be. These
 * payloads are a few kilobytes, so the cost is irrelevant.
 */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Maps a pipeline result to the closed set of metric outcome labels.
 *
 * Both SKIPPED_* results collapse to `skipped`: for the purpose of "is the
 * pipeline healthy?", a redelivered job that correctly declined to work twice
 * is one phenomenon, and splitting it would produce two panels that are always
 * read together.
 */
function outcomeLabel(status: string): ExtractionOutcome {
  if (status === 'COMPLETED') return 'completed';
  if (status === 'NEEDS_REVIEW') return 'needs_review';
  if (status === 'FAILED') return 'failed';
  return 'skipped';
}

/** Signals the queue to retry, distinct from a document-level failure. */
export class RetriableProviderError extends Error {
  readonly retriable = true;

  constructor(message: string) {
    super(message);
    this.name = 'RetriableProviderError';
    Object.setPrototypeOf(this, RetriableProviderError.prototype);
  }
}
