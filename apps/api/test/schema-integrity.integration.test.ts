import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './helpers/test-app.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
}, 180_000);

afterAll(async () => {
  if (ctx) await destroyTestContext(ctx);
});

/**
 * Guards structural facts that Prisma does not manage and therefore actively
 * destroys.
 *
 * This suite exists because of a real incident during M4: Prisma cannot express
 * an HNSW index, so it classified the hand-written pgvector index as schema
 * drift and emitted `DROP INDEX` in the next generated migration. Nothing
 * failed — vector search simply degraded to a sequential scan, which is correct
 * but slow, and would have shipped unnoticed.
 *
 * These assertions run against a database built by `prisma migrate deploy`, the
 * same command production uses, so any migration that removes them fails CI.
 */
describe('schema integrity', () => {
  const query = <T>(sql: string): Promise<T[]> => ctx.prisma.client.$queryRawUnsafe<T[]>(sql);

  it('has the pgvector extension installed', async () => {
    const rows = await query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(rows).toHaveLength(1);
  });

  it('keeps the HNSW index on document_chunks.embedding', async () => {
    // If this fails, check the most recent migration for a DROP INDEX that
    // Prisma generated automatically, and remove that line.
    const rows = await query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'document_chunks' AND indexdef ILIKE '%hnsw%'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexname).toBe('document_chunks_embedding_idx');
    // The operator class must match the `<=>` operator used at query time;
    // an l2 index would simply never be chosen for cosine ordering.
    expect(rows[0]!.indexdef).toContain('vector_cosine_ops');
  });

  it('declares the embedding column at the configured dimensionality', async () => {
    // A mismatch between the column and EMBEDDING_DIM surfaces as a runtime
    // insert error on the very first document, long after deploy.
    const rows = await query<{ format_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS format_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = 'document_chunks' AND a.attname = 'embedding'`,
    );
    expect(rows[0]?.format_type).toBe('vector(384)');
  });

  it('allows content_sha256 to be null while an upload is in flight', async () => {
    // The hash cannot exist until the bytes do. NULLs are distinct in a unique
    // index, so this is also what lets one user have several uploads pending.
    const rows = await query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'documents' AND column_name = 'content_sha256'`,
    );
    expect(rows[0]?.is_nullable).toBe('YES');
  });

  it('enforces per-uploader deduplication on content hash', async () => {
    const rows = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'documents' AND indexname = 'documents_dedupe'`,
    );
    expect(rows[0]?.indexdef).toMatch(/UNIQUE/);
    expect(rows[0]?.indexdef).toContain('uploader_id');
    expect(rows[0]?.indexdef).toContain('content_sha256');
  });

  it('stores every timestamp with a time zone', async () => {
    // A naive `timestamp` column silently reinterprets instants in the server's
    // local zone, which corrupts date-sanity rules the moment the deploy region
    // differs from the developer's laptop.
    const rows = await query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type LIKE 'timestamp%'
         AND data_type <> 'timestamp with time zone'`,
    );
    expect(rows).toEqual([]);
  });
});
