import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { toVectorLiteral, type EmbeddingProvider } from '@invoiceiq/ai';
import { InvoiceExtractionSchema, buildChunks } from '@invoiceiq/domain';
import { Prisma, type PrismaClient } from '@invoiceiq/database';
import { EMBEDDING_PROVIDER } from '../embedding/embedding.module.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { StorageService } from '../infrastructure/storage/storage.service.js';
import { QUEUE_EMBEDDING, type EmbedDocumentJob } from '../queues.js';
import { extractPdfText } from './pdf-text.js';

/**
 * Embeds a document for semantic search.
 *
 * A separate queue from extraction on purpose. Embedding is cheap, fast and
 * safe to retry aggressively; extraction is expensive, slow and rate-limited.
 * Sharing a queue would mean one retry policy for both, and a burst of
 * embedding work could starve the LLM calls that actually matter.
 *
 * It is also deliberately *not* part of the extraction transaction: a document
 * that extracted correctly but failed to embed is still a perfectly good
 * document, merely one that search cannot find yet. Failing the extraction over
 * that would be the wrong trade.
 */
@Processor(QUEUE_EMBEDDING, { concurrency: 5 })
export class EmbedDocumentProcessor extends WorkerHost {
  private readonly logger = new Logger(EmbedDocumentProcessor.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly storage: StorageService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
  ) {
    super();
  }

  private get prisma(): PrismaClient {
    return this.prismaService.client;
  }

  async process(job: Job<EmbedDocumentJob>): Promise<{ chunks: number }> {
    const { documentId, extractionId } = job.data;

    const extraction = await this.prisma.extraction.findUnique({
      where: { id: extractionId },
      include: { document: true },
    });

    if (!extraction) {
      // The document was deleted between extraction and embedding. Not an
      // error worth retrying.
      this.logger.log(`${documentId}: extraction is gone — acknowledging`);
      return { chunks: 0 };
    }

    const parsed = InvoiceExtractionSchema.safeParse(extraction.data);
    if (!parsed.success) {
      // Unreachable in practice: nothing unvalidated is ever stored. Guarding
      // anyway, because retrying this forever would achieve nothing.
      this.logger.warn(`${documentId}: stored extraction does not parse — skipping embedding`);
      return { chunks: 0 };
    }

    // Re-read the PDF rather than caching its text on the document row: text is
    // large, needed exactly twice, and keeping it would bloat every query that
    // selects a document.
    const bytes = await this.storage.download(extraction.document.s3Key);
    const pdf = await extractPdfText(bytes);

    const chunks = buildChunks(pdf.text, parsed.data);
    const vectors = await this.embedder.embed(chunks.map((chunk) => chunk.content));

    await this.persist(documentId, chunks, vectors);

    this.logger.log(`${documentId}: embedded ${chunks.length} chunks`);
    return { chunks: chunks.length };
  }

  /**
   * Replaces this document's chunks in one transaction.
   *
   * Delete-then-insert rather than upsert: a correction can change the number
   * of chunks, and leaving orphans from a previous version would let search
   * return text the document no longer contains.
   */
  private async persist(
    documentId: string,
    chunks: readonly { index: number; kind: string; content: string }[],
    vectors: readonly number[][],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.documentChunk.deleteMany({ where: { documentId } });

      for (const [i, chunk] of chunks.entries()) {
        const vector = vectors[i];
        if (!vector) continue;

        // Raw SQL because Prisma has no pgvector type — the column is
        // Unsupported, so it cannot appear in a generated `create`. Parameters
        // are bound by the tagged template; the vector is never concatenated
        // into the statement.
        await tx.$executeRaw`
          INSERT INTO document_chunks (id, document_id, chunk_index, kind, content, embedding)
          VALUES (
            gen_random_uuid(),
            ${documentId}::uuid,
            ${chunk.index},
            ${chunk.kind},
            ${chunk.content},
            ${toVectorLiteral(vector)}::vector
          )
        `;
      }
    });
  }
}

export { Prisma };
