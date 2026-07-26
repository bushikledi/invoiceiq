-- pgvector must exist before document_chunks declares a vector(384) column.
-- This is why the extension is created in migration SQL rather than via the
-- `postgresqlExtensions` preview feature: the ordering has to be explicit, and
-- the HNSW index below cannot be expressed in the Prisma schema at all.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('REVIEWER', 'ADMIN');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('UPLOADED', 'QUEUED', 'PROCESSING', 'EXTRACTED', 'VALIDATING', 'NEEDS_REVIEW', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "finding_severity" AS ENUM ('ERROR', 'WARNING');

-- CreateEnum
CREATE TYPE "review_action" AS ENUM ('APPROVED', 'CORRECTED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'REVIEWER',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "uploader_id" UUID NOT NULL,
    "status" "document_status" NOT NULL DEFAULT 'UPLOADED',
    "original_name" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "page_count" INTEGER,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_events" (
    "id" BIGSERIAL NOT NULL,
    "document_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extractions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "field_meta" JSONB NOT NULL,
    "overall_confidence" DECIMAL(4,3) NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_usd" DECIMAL(10,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_findings" (
    "id" BIGSERIAL NOT NULL,
    "extraction_id" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" "finding_severity" NOT NULL,
    "field_path" TEXT,
    "message" TEXT NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "validation_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_decisions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "action" "review_action" NOT NULL,
    "corrections" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'raw',
    "content" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_family_id_idx" ON "refresh_tokens"("user_id", "family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "documents_status_idx" ON "documents"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "documents_cursor_idx" ON "documents"("uploader_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "documents_dedupe" ON "documents"("uploader_id", "content_sha256");

-- CreateIndex
CREATE INDEX "document_events_document_id_created_at_idx" ON "document_events"("document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "extractions_document_id_version_key" ON "extractions"("document_id", "version");

-- CreateIndex
CREATE INDEX "validation_findings_extraction_id_idx" ON "validation_findings"("extraction_id");

-- CreateIndex
CREATE INDEX "review_decisions_document_id_created_at_idx" ON "review_decisions"("document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_document_id_chunk_index_key" ON "document_chunks"("document_id", "chunk_index");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_extraction_id_fkey" FOREIGN KEY ("extraction_id") REFERENCES "extractions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HNSW over IVFFlat: no training step, so it works correctly with 5 seed rows,
-- and it gives better recall/latency at this scale. Build cost is irrelevant
-- for a corpus this size.
--
-- vector_cosine_ops must match the operator used at query time (<=>).
CREATE INDEX "document_chunks_embedding_idx"
  ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- Supports filtering search results down to a single document.
CREATE INDEX "document_chunks_document_id_idx"
  ON "document_chunks" ("document_id");
