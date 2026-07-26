import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ConflictError, NotFoundError, ValidationError, assertTransition } from '@invoiceiq/domain';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_REJECTIONS,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type DocumentSummary,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
} from '@invoiceiq/contracts';
import { Prisma, type Document, type PrismaClient } from '@invoiceiq/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { StorageService } from '../../infrastructure/storage/storage.service.js';
import { currentTraceId } from '../../common/trace/trace-context.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { QUEUE_EXTRACTION, JOB_EXTRACT_DOCUMENT } from './queue.constants.js';

/** `%PDF-` — the file signature every PDF must start with. */
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly storage: StorageService,
    @InjectQueue(QUEUE_EXTRACTION) private readonly extractionQueue: Queue,
    @InjectPinoLogger(DocumentsService.name) private readonly logger: PinoLogger,
  ) {}

  private get prisma(): PrismaClient {
    return this.prismaService.client;
  }

  /**
   * Step 1: reserve a document row and hand back a presigned PUT.
   *
   * The bytes go straight from the browser to object storage. Proxying them
   * through the API would put a 10 MB body on the request path of a 512 MB
   * process and burn the proxy's request timeout on a slow upload, for no
   * benefit — we cannot trust the client's claims either way (see complete()).
   */
  async createUpload(userId: string, request: CreateUploadRequest): Promise<CreateUploadResponse> {
    const s3Key = this.storage.newDocumentKey();

    const document = await this.prisma.document.create({
      data: {
        uploaderId: userId,
        originalName: request.filename,
        s3Key,
        sizeBytes: request.sizeBytes,
        status: 'UPLOADED',
        // Unknown until the bytes exist. NULL keeps the dedupe index inert for
        // in-flight uploads.
        contentSha256: null,
      },
    });

    const uploadUrl = await this.storage.presignUpload(
      s3Key,
      request.sizeBytes,
      request.contentType,
    );

    return {
      documentId: document.id,
      uploadUrl,
      s3Key,
      expiresInSeconds: 300,
    };
  }

  /**
   * Step 2: the trust boundary.
   *
   * The client saying "I uploaded it" proves nothing — the presigned URL could
   * have been used to store anything within the signed constraints, or nothing
   * at all. So the server reads the object back and verifies it: existence,
   * size, and the %PDF- signature. Only then does the document enter the
   * pipeline.
   */
  async completeUpload(userId: string, documentId: string): Promise<DocumentSummary> {
    const document = await this.findOwned(userId, documentId);

    // Idempotent: a retried request on an already-queued document returns the
    // current state rather than enqueueing a second job.
    if (document.status !== 'UPLOADED') {
      return toSummary(document);
    }

    const metadata = await this.storage.head(document.s3Key);
    if (!metadata) {
      await this.fail(document, UPLOAD_REJECTIONS.MISSING_OBJECT);
      throw new ValidationError(UPLOAD_REJECTIONS.MISSING_OBJECT);
    }

    if (metadata.sizeBytes > MAX_UPLOAD_BYTES) {
      await this.fail(document, UPLOAD_REJECTIONS.TOO_LARGE);
      throw new ValidationError(UPLOAD_REJECTIONS.TOO_LARGE);
    }

    // Content-Type is client-supplied metadata and trivially spoofed, so the
    // actual bytes are what decide. A renamed .exe fails here.
    const prefix = await this.storage.readPrefix(document.s3Key, PDF_MAGIC.length);
    if (!prefix.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      await this.fail(document, UPLOAD_REJECTIONS.NOT_A_PDF);
      throw new ValidationError(UPLOAD_REJECTIONS.NOT_A_PDF);
    }

    const contentSha256 = await this.storage.sha256(document.s3Key);

    const duplicate = await this.prisma.document.findFirst({
      where: { uploaderId: userId, contentSha256, id: { not: document.id } },
    });

    if (duplicate) {
      // Re-uploading identical bytes is not an error; it is a no-op that costs
      // no LLM spend. The caller gets the original document back.
      this.logger.info(
        { documentId: document.id, duplicateOf: duplicate.id },
        'Duplicate upload discarded',
      );
      await this.prisma.document.delete({ where: { id: document.id } });
      return toSummary(duplicate);
    }

    assertTransition(document.status, 'QUEUED');

    const queued = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.document.update({
        where: { id: document.id },
        data: {
          status: 'QUEUED',
          contentSha256,
          sizeBytes: metadata.sizeBytes,
        },
      });

      await tx.documentEvent.create({
        data: {
          documentId: document.id,
          type: 'STATUS_CHANGED',
          payload: { from: 'UPLOADED', to: 'QUEUED', sizeBytes: metadata.sizeBytes },
        },
      });

      return updated;
    });

    await this.enqueueExtraction(queued.id, contentSha256);

    return toSummary(queued);
  }

  /**
   * Enqueues extraction.
   *
   * jobId is the document id, so BullMQ deduplicates: if the HTTP response is
   * lost and the client retries, the second enqueue is a no-op rather than a
   * second LLM bill. Combined with the processor's status guard, the pipeline
   * is idempotent end to end.
   */
  private async enqueueExtraction(documentId: string, contentSha256: string): Promise<void> {
    await this.extractionQueue.add(
      JOB_EXTRACT_DOCUMENT,
      { documentId, contentSha256, traceId: currentTraceId() },
      { jobId: documentId },
    );
  }

  async list(userId: string, query: ListDocumentsQuery): Promise<ListDocumentsResponse> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

    const where: Prisma.DocumentWhereInput = {
      uploaderId: userId,
      ...(query.status ? { status: query.status } : {}),
      // Keyset predicate: strictly "older than the last row read", with id
      // breaking ties inside the same timestamp.
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    // Fetch one extra row to learn whether another page exists, without a
    // second COUNT query.
    const rows = await this.prisma.document.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items.at(-1);

    return {
      items: items.map(toSummary),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async get(userId: string, documentId: string): Promise<DocumentSummary> {
    return toSummary(await this.findOwned(userId, documentId));
  }

  /** Short-lived presigned GET for the PDF viewer. */
  async fileUrl(
    userId: string,
    documentId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const document = await this.findOwned(userId, documentId);
    return {
      url: await this.storage.presignDownload(document.s3Key),
      expiresInSeconds: 300,
    };
  }

  /**
   * Loads a document, scoped to its owner.
   *
   * Ownership is part of the lookup rather than a separate check afterwards: a
   * missing row and someone else's row return the same 404, so the endpoint
   * cannot be used to probe which document ids exist.
   */
  private async findOwned(userId: string, documentId: string): Promise<Document> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, uploaderId: userId },
    });

    if (!document) {
      throw new NotFoundError('Document', documentId);
    }

    return document;
  }

  private async fail(document: Document, reason: string): Promise<void> {
    assertTransition(document.status, 'FAILED');

    await this.prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id: document.id },
        data: { status: 'FAILED', failureReason: reason },
      });
      await tx.documentEvent.create({
        data: {
          documentId: document.id,
          type: 'STATUS_CHANGED',
          payload: { from: document.status, to: 'FAILED', reason },
        },
      });
    });
  }
}

function toSummary(document: Document): DocumentSummary {
  return {
    id: document.id,
    status: document.status,
    originalName: document.originalName,
    sizeBytes: document.sizeBytes,
    pageCount: document.pageCount,
    failureReason: document.failureReason,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

export { ConflictError };
