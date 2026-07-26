# 6. pgvector rather than a dedicated vector store

**Status:** accepted

## Context

Semantic search needs vector similarity. The corpus is thousands of chunks, not
millions.

## Decision

Store embeddings in PostgreSQL using pgvector with an HNSW index.

## Consequences

**Data gravity wins at this scale.** Search results must be filtered by uploader
and joined to workflow state — status, extraction version, confidence. In
Postgres that is one query. With an external store it is a vector lookup, then
a fetch, then reconciliation of two systems that can disagree, plus a second
backup story and a second thing to run locally.

HNSW over IVFFlat because IVFFlat needs a training step and behaves poorly on a
near-empty table; HNSW works correctly with five seed rows, which is what the
demo actually has.

**The cost is real and specific:** Prisma has no pgvector type. The column is
`Unsupported("vector(384)")`, so inserts and search are raw SQL. That is
confined to two files, and every value is a bound parameter — interpolating an
embedding into SQL would be the most obvious injection point in the system.

Worse, Prisma does not know the HNSW index exists and emits `DROP INDEX` for it
in the next generated migration. This happened. Nothing failed: vector search
stayed _correct_ and silently fell back to a sequential scan.
`schema-integrity.integration.test.ts` now asserts the index exists against a
database built by `prisma migrate deploy`, so CI catches it.

## Alternatives

**Pinecone / Qdrant.** Better at millions of vectors, and the right answer if
this grew. Rejected: an extra service to run, pay for and back up, in exchange
for scale headroom the project does not need.
