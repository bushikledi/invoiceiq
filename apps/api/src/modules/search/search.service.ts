import { Inject, Injectable } from '@nestjs/common';
import {
  DeterministicEmbeddingProvider,
  LocalEmbeddingProvider,
  OpenAiEmbeddingProvider,
  toVectorLiteral,
  type EmbeddingProvider,
} from '@invoiceiq/ai';
import type { SearchHit, SearchResponse } from '@invoiceiq/contracts';
import { Prisma, type PrismaClient } from '@invoiceiq/database';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

/**
 * Shape returned by the raw similarity query.
 *
 * `status` is typed as the domain union rather than `string`: we author this
 * type ourselves, the column is a Postgres enum with exactly these members, and
 * declaring it accurately here beats casting at every use site.
 */
interface HitRow {
  document_id: string;
  original_name: string;
  status: SearchHit['status'];
  content: string;
  kind: string;
  distance: number;
  /**
   * The latest extraction's JSONB payload, or null when the document has none.
   *
   * Declared narrowly here rather than as `unknown` and cast below: only these
   * four fields are read, and saying so once is clearer than an inline cast at
   * the point of use.
   */
  data: {
    invoiceNumber?: string;
    vendor?: { name?: string };
    totalCents?: number;
    currency?: string;
  } | null;
}

@Injectable()
export class SearchService {
  private readonly embedder: EmbeddingProvider;

  constructor(
    private readonly prismaService: PrismaService,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    // The API embeds only the query — one short string, no batching, no model
    // download in the common case. It must use the SAME model as the worker,
    // or the query vector lands in a different space from the documents and
    // every result is noise.
    this.embedder = buildEmbedder(env);
  }

  private get prisma(): PrismaClient {
    return this.prismaService.client;
  }

  /**
   * Semantic search over document chunks.
   *
   * Results are deduplicated to one row per document: a long invoice produces
   * many chunks, several of which may match, and a page of results showing the
   * same document five times is useless. DISTINCT ON keeps the best-scoring
   * chunk per document, which is also the right snippet to display.
   */
  async search(userId: string, query: string, limit: number): Promise<SearchResponse> {
    const startedAt = Date.now();

    const [vector] = await this.embedder.embed([query]);
    if (!vector) {
      return { query, hits: [], tookMs: Date.now() - startedAt };
    }

    const literal = toVectorLiteral(vector);

    /*
     * The one raw query in the codebase, because Prisma cannot express the
     * `<=>` operator.
     *
     * Every value is a bound parameter — the embedding is passed as a string
     * and cast, never concatenated. Interpolating a vector into SQL would be
     * the single most obvious injection point in the system.
     *
     * The inner DISTINCT ON picks each document's closest chunk; the outer
     * ORDER BY then ranks documents against each other.
     */
    const rows = await this.prisma.$queryRaw<HitRow[]>`
      SELECT * FROM (
        SELECT DISTINCT ON (c.document_id)
          c.document_id,
          d.original_name,
          d.status::text AS status,
          c.content,
          c.kind,
          (c.embedding <=> ${literal}::vector) AS distance,
          e.data
        FROM document_chunks c
        JOIN documents d ON d.id = c.document_id
        LEFT JOIN LATERAL (
          SELECT data FROM extractions
          WHERE document_id = c.document_id
          ORDER BY version DESC
          LIMIT 1
        ) e ON TRUE
        WHERE d.uploader_id = ${userId}::uuid
        ORDER BY c.document_id, c.embedding <=> ${literal}::vector
      ) best
      ORDER BY best.distance
      LIMIT ${limit}
    `;

    return {
      query,
      hits: rows.map(toHit),
      tookMs: Date.now() - startedAt,
    };
  }
}

function toHit(row: HitRow): SearchHit {
  const data = row.data;

  return {
    documentId: row.document_id,
    originalName: row.original_name,
    status: row.status,
    snippet: row.content.length > 300 ? `${row.content.slice(0, 300)}…` : row.content,
    kind: row.kind,
    // Cosine distance runs 0 (identical) to 2 (opposite). Inverting to a 0..1
    // similarity is what a user expects a "score" to mean.
    score: Math.max(0, 1 - Number(row.distance)),
    invoiceNumber: data?.invoiceNumber ?? null,
    vendorName: data?.vendor?.name ?? null,
    totalCents: data?.totalCents ?? null,
    currency: data?.currency ?? null,
  };
}

/**
 * Mirrors the worker's provider selection.
 *
 * Query and document vectors must come from the same model; a mismatch is not
 * an error anywhere, it simply returns nonsense, which is the hardest kind of
 * bug to notice.
 */
function buildEmbedder(env: ApiEnv): EmbeddingProvider {
  if (env.EMBEDDING_PROVIDER === 'openai') {
    if (!env.OPENAI_API_KEY) {
      throw new Error('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY');
    }
    return new OpenAiEmbeddingProvider({
      apiKey: env.OPENAI_API_KEY,
      dimensions: env.EMBEDDING_DIM,
    });
  }

  if (env.EMBEDDING_PROVIDER === 'deterministic') {
    return new DeterministicEmbeddingProvider(env.EMBEDDING_DIM);
  }

  return new LocalEmbeddingProvider({
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIM,
  });
}

export { Prisma };
