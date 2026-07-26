# InvoiceIQ — Production-Grade Implementation Plan

**AI Document Extraction Pipeline: PDF invoice → LLM structured extraction → validation → human review → semantic search**

> Author role: Senior Software Architect / Staff Engineer
> Stack: NestJS · TypeScript · PostgreSQL + pgvector · BullMQ + Redis · Anthropic/OpenAI structured outputs · Zod · S3/MinIO · Next.js 15 App Router · Docker · GitHub Actions · Railway/Fly.io

---

## 0. How to Read This Plan

The plan is split into three phases. Each phase is shippable on its own and each is a strict superset of the previous one. **Do not start Phase N+1 work while Phase N is unmerged.** Scope creep is the #1 killer of portfolio projects; the "Explicitly Out of Scope" list at the end is contractual.

| Phase | Name                 | Goal                                                                      | Duration (solo, part-time) |
| ----- | -------------------- | ------------------------------------------------------------------------- | -------------------------- |
| 0     | Foundations          | Repo, tooling, CI skeleton, local infra, walking skeleton                 | ~1 week                    |
| 1     | MVP                  | Full happy path + review dashboard + search, deployed with demo data      | ~4–5 weeks                 |
| 2     | Production hardening | Observability, cost controls, resilience, security hardening, load sanity | ~2 weeks                   |

**Definition of done for the whole project:** a stranger can open a URL, log in with a demo account, drag in a PDF, watch it move through `QUEUED → PROCESSING → NEEDS_REVIEW/COMPLETED`, correct a flagged field, semantically search "office chairs from Milan vendor", and export CSV — while you can show green CI, tests with recorded LLM fixtures, and a clean architecture diagram.

---

## 1. Guiding Principles (applied throughout)

1. **Clean Architecture, pragmatically.** Domain logic (validation rules, confidence policy, extraction schema) has zero imports from NestJS, Prisma, BullMQ, or the AI SDK. Frameworks live at the edges. But no ceremony for ceremony's sake — this is a modular monolith, not microservices.
2. **DDD-lite.** One bounded context (`invoicing-extraction`), with clearly named aggregates: `Document`, `Extraction`, `ReviewDecision`. Ubiquitous language is enforced in code: never "file/blob/record" when you mean `Document`.
3. **SOLID where it pays.** The two seams that matter here: the LLM provider (interface + adapters, so Anthropic/OpenAI are swappable and mockable) and storage (S3 vs MinIO behind one port). Everything else uses plain dependency injection via Nest.
4. **The queue is the spine.** HTTP handlers never call the LLM. Every long-running step is a job with idempotency, retry semantics, and a dead-letter path.
5. **Determinism at the boundaries of non-determinism.** The LLM is non-deterministic; everything around it (schema, retries, fixtures, confidence policy) is deterministic and unit-testable.
6. **12-factor.** Config from env, validated at boot with Zod; stateless processes; logs to stdout; disposability (workers drain gracefully).

---

## 2. System Architecture

### 2.1 High-level (C4 level 2 — containers)

```
                        ┌─────────────────────────────┐
                        │        Next.js 15 (web)      │
                        │  App Router, TanStack Query  │
                        └───────────┬─────────────────┘
                                    │ HTTPS (REST + SSE)
                        ┌───────────▼─────────────────┐
                        │        NestJS API            │
                        │  auth · upload · documents   │
                        │  review · search · export    │
                        └──┬─────────┬─────────┬──────┘
             presigned PUT │         │ enqueue │ SQL
                ┌──────────▼──┐  ┌───▼───┐  ┌──▼───────────────┐
                │  S3 / MinIO │  │ Redis │  │ PostgreSQL 16     │
                │  (pdfs)     │  │BullMQ │  │ + pgvector        │
                └──────────▲──┘  └───▲───┘  └──▲───────────────┘
                     read  │         │ consume │ SQL
                        ┌──┴─────────┴─────────┴──────┐
                        │       NestJS Worker          │
                        │ pdf→text → LLM extract →     │
                        │ validate → confidence →      │
                        │ embed → persist              │
                        └───────────┬─────────────────┘
                                    │ HTTPS
                        ┌───────────▼─────────────────┐
                        │  LLM Provider (Anthropic/    │
                        │  OpenAI) — structured output │
                        └─────────────────────────────┘
```

**Two deployable processes, one codebase.** API and Worker are separate Nest applications sharing the same domain packages, deployed as two services from one Docker image (`CMD` differs). This gives independent scaling and crash isolation of LLM work without microservice overhead.

### 2.2 Logical layering (Clean Architecture inside each app)

```
┌──────────────────────────────────────────────────────────┐
│ Interface layer     controllers, BullMQ processors, DTOs │  ← Nest decorators live here only
├──────────────────────────────────────────────────────────┤
│ Application layer   use-cases (services), transactions,  │  ← orchestration, no business math
│                     ports (interfaces)                   │
├──────────────────────────────────────────────────────────┤
│ Domain layer        entities, value objects, invariants, │  ← pure TS, zero framework imports,
│                     business-rule validators, policies   │    100% unit-testable
├──────────────────────────────────────────────────────────┤
│ Infrastructure      Prisma repos, S3 adapter, LLM        │  ← implements the ports
│                     adapters, embedding adapter, Redis   │
└──────────────────────────────────────────────────────────┘
```

Dependency rule: arrows point inward only. Enforced with `eslint-plugin-boundaries` (or `dependency-cruiser`) in CI — this is the difference between "we intend clean architecture" and "we have it".

### 2.3 Document state machine (the core domain concept)

```
UPLOADED → QUEUED → PROCESSING → EXTRACTED → VALIDATING
                                     │              │
                                     │              ├─ all fields pass + high confidence → COMPLETED
                                     │              └─ any rule failed / low confidence → NEEDS_REVIEW
                                     │                              │ human corrects/approves
                                     │                              ▼
                                     │                          COMPLETED
                                     └─ unrecoverable (bad PDF, schema fail after N retries) → FAILED
```

Model this explicitly as a `DocumentStatus` enum plus a `canTransition(from, to)` guard in the domain layer. Every transition writes a row to `document_events` (append-only audit) — cheap to build now, gold in interviews ("how do you debug a stuck document?" → event timeline).

---

## 3. Repository & Folder Structure

**Monorepo with pnpm workspaces + Turborepo.** One repo demos better, shares the Zod schemas end-to-end (the single biggest DRY win in this project: the extraction schema is used by the worker, the API DTOs, and the frontend types), and keeps CI simple.

```
invoiceiq/
├── apps/
│   ├── api/                        # NestJS HTTP application
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   └── modules/
│   │   │       ├── auth/           # controllers, guards, strategies (interface layer)
│   │   │       ├── documents/
│   │   │       ├── review/
│   │   │       ├── search/
│   │   │       ├── export/
│   │   │       └── health/
│   │   └── test/                   # api e2e tests (supertest + testcontainers)
│   ├── worker/                     # NestJS standalone app (no HTTP server)
│   │   ├── src/
│   │   │   ├── main.ts             # bootstrapApplicationContext + graceful drain
│   │   │   └── processors/
│   │   │       ├── extract-document.processor.ts
│   │   │       └── embed-document.processor.ts
│   │   └── test/
│   └── web/                        # Next.js 15 App Router
│       ├── app/
│       │   ├── (auth)/login/
│       │   ├── (dashboard)/
│       │   │   ├── documents/          # list
│       │   │   ├── documents/[id]/     # review detail: PDF ⟷ fields
│       │   │   └── search/
│       │   └── api/                    # route handlers ONLY for auth cookie bridge
│       ├── components/
│       ├── lib/                        # api client, query hooks
│       └── e2e/                        # Playwright smoke tests
├── packages/
│   ├── domain/                     # ← THE HEART. Pure TS, zero deps except zod
│   │   ├── src/
│   │   │   ├── document/           # Document entity, DocumentStatus, transitions
│   │   │   ├── extraction/
│   │   │   │   ├── invoice-schema.ts        # Zod schema (single source of truth)
│   │   │   │   ├── business-rules.ts        # sum/VAT/date validators
│   │   │   │   └── confidence-policy.ts     # thresholds, field flagging
│   │   │   └── shared/             # Money value object, Result<T,E> type
│   │   └── package.json
│   ├── contracts/                  # API DTOs + response types (zod), shared FE/BE
│   ├── ai/                         # LlmExtractor port + Anthropic/OpenAI/Fixture adapters,
│   │   │                           #   prompt templates, corrective-retry loop, token counting
│   │   └── src/fixtures/           # recorded LLM responses (JSON) for tests
│   ├── database/                   # Prisma schema, migrations, repositories, seed
│   └── config/                     # env schema (zod), shared tsconfig/eslint presets
├── infra/
│   ├── docker-compose.yml          # postgres+pgvector, redis, minio, api, worker, web
│   ├── docker-compose.test.yml
│   └── Dockerfile                  # multi-stage, shared by api & worker
├── .github/workflows/
│   ├── ci.yml
│   └── deploy.yml
├── docs/
│   ├── adr/                        # 0001-monorepo.md, 0002-queue.md, ...
│   └── architecture.md             # the diagram above + state machine
├── turbo.json
└── pnpm-workspace.yaml
```

**Rules that keep this clean:**

- `packages/domain` may import only `zod`. CI fails if anything else appears in its dependency graph.
- `apps/web` imports types from `packages/contracts` only — never from `database` or `ai`.
- Prisma client is generated into `packages/database` and never leaks entities upward; repositories map Prisma rows → domain entities.

---

## 4. Database Design (PostgreSQL 16 + pgvector)

### 4.1 Schema

```sql
-- users & auth ---------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,               -- argon2id
  role          TEXT NOT NULL DEFAULT 'reviewer',  -- 'reviewer' | 'admin' (simple RBAC)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,                -- sha256 of the opaque token
  family_id    UUID NOT NULL,                -- rotation family for reuse detection
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (user_id, family_id);

-- documents ------------------------------------------------------------
CREATE TYPE document_status AS ENUM
  ('UPLOADED','QUEUED','PROCESSING','EXTRACTED','VALIDATING',
   'NEEDS_REVIEW','COMPLETED','FAILED');

CREATE TABLE documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id    UUID NOT NULL REFERENCES users(id),
  status         document_status NOT NULL DEFAULT 'UPLOADED',
  original_name  TEXT NOT NULL,
  s3_key         TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,              -- dedupe + idempotency + LLM cache key
  size_bytes     INT  NOT NULL,
  page_count     INT,
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX documents_dedupe ON documents (uploader_id, content_sha256);
CREATE INDEX documents_status_idx ON documents (status, created_at DESC);

CREATE TABLE document_events (                -- append-only audit / debugging timeline
  id          BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                 -- 'STATUS_CHANGED','LLM_RETRY','RULE_FAILED',...
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON document_events (document_id, created_at);

-- extraction -----------------------------------------------------------
CREATE TABLE extractions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version        INT  NOT NULL DEFAULT 1,    -- bumped on human correction
  data           JSONB NOT NULL,             -- the Zod-validated invoice payload
  field_meta     JSONB NOT NULL,             -- per-field {confidence, flagged, source}
  overall_confidence NUMERIC(4,3) NOT NULL,
  model          TEXT NOT NULL,              -- e.g. 'claude-haiku-4-5'
  prompt_version TEXT NOT NULL,              -- pin prompts like code
  attempts       INT NOT NULL,               -- retries consumed
  input_tokens   INT NOT NULL,
  output_tokens  INT NOT NULL,
  cost_usd       NUMERIC(10,6) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

CREATE TABLE validation_findings (            -- one row per failed/warned business rule
  id            BIGSERIAL PRIMARY KEY,
  extraction_id UUID NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
  rule          TEXT NOT NULL,               -- 'LINE_ITEMS_SUM','VAT_ARITHMETIC','DATE_SANITY'
  severity      TEXT NOT NULL,               -- 'ERROR' | 'WARNING'
  field_path    TEXT,                        -- 'lineItems[2].total'
  message       TEXT NOT NULL,
  resolved_at   TIMESTAMPTZ
);

CREATE TABLE review_decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES documents(id),
  reviewer_id   UUID NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL,               -- 'APPROVED' | 'CORRECTED' | 'REJECTED'
  corrections   JSONB,                       -- json-patch of changed fields
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- search ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE document_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content     TEXT NOT NULL,                 -- the chunk text (for result display)
  embedding   vector(1536) NOT NULL,         -- match your embedding model dim
  UNIQUE (document_id, chunk_index)
);
-- HNSW: better recall/latency than IVFFlat at this scale, no training step
CREATE INDEX document_chunks_embedding_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);
```

### 4.2 Design rationale

- **`JSONB` for extraction payloads, columns for workflow state.** The invoice shape is owned by the Zod schema and evolves; the workflow (status, confidence, cost) is relational and queried constantly. Don't normalize line items into rows for the MVP — you never query "all line items across invoices" and it would triple repository code. Revisit only if analytics become in-scope (they're not).
- **`content_sha256` unique per uploader** gives you free idempotent uploads, duplicate detection, and the cache key for "we already extracted this exact file".
- **Extraction versioning** instead of mutation: human corrections create version 2 with `field_meta.source = 'human'`. You keep the original for model-quality analysis and a clean audit story.
- **Money as `NUMERIC` in JSONB? No —** inside `data` JSONB, store money as **integer minor units (cents) + currency code**, enforced by the Zod schema. Floats never touch money. The domain has a `Money` value object for the sum/VAT arithmetic.
- **HNSW over IVFFlat**: no training step (works with 5 rows of seed data), better recall; index build cost is irrelevant at portfolio scale.

---

## 5. API Design (NestJS, REST)

### 5.1 Conventions

- Versioned base path `/api/v1`. JSON everywhere; errors use a single envelope (RFC 7807-style):
  ```json
  {
    "type": "validation_error",
    "title": "Invalid payload",
    "status": 422,
    "detail": "...",
    "errors": [{ "path": "email", "message": "..." }],
    "traceId": "..."
  }
  ```
- Every request gets a `traceId` (from `AsyncLocalStorage` middleware) echoed in errors and logs.
- DTO validation with **Zod via `nestjs-zod`** (not class-validator) so the same schemas in `packages/contracts` type the frontend client. One validation technology across the whole system is a deliberate architectural decision — say so in an ADR.
- Pagination: cursor-based (`?cursor=...&limit=20`) on the documents list — trivial with `created_at,id` compound cursor and it's the professional default.

### 5.2 Endpoints

```
POST   /api/v1/auth/register            (Phase 1 optional; seed users may suffice)
POST   /api/v1/auth/login               → { accessToken (15m) } + httpOnly refresh cookie
POST   /api/v1/auth/refresh             → rotates refresh token (family reuse detection)
POST   /api/v1/auth/logout              → revokes token family

POST   /api/v1/documents/uploads        → { uploadUrl, s3Key, documentId }   [presigned PUT]
POST   /api/v1/documents/:id/complete   → client confirms upload; server HEADs S3,
                                          verifies size/type/sha, sets QUEUED, enqueues job
GET    /api/v1/documents?status=&cursor=&limit=
GET    /api/v1/documents/:id            → document + latest extraction + findings + events
GET    /api/v1/documents/:id/file       → short-lived presigned GET (PDF viewer)
GET    /api/v1/documents/:id/stream     → SSE: status updates (see 5.3)

POST   /api/v1/documents/:id/review     → { action: APPROVED|CORRECTED|REJECTED,
                                            corrections?: [{path, value}] }
                                          server re-runs business rules on corrected data;
                                          creates extraction v2; transitions to COMPLETED

GET    /api/v1/search?q=...&limit=10    → semantic search (embeds q, cosine top-k,
                                          joins document + snippet + score)

GET    /api/v1/export?format=csv|json&status=&from=&to=   → streamed response

GET    /api/v1/health/live | /health/ready   (readiness checks pg/redis/s3)
```

### 5.3 Realtime status: SSE, not WebSockets

The dashboard needs "watch the PDF flip from PROCESSING to NEEDS_REVIEW". SSE via a Nest `@Sse()` endpoint backed by Redis pub/sub (worker publishes on transition) is one-directional, works through proxies, needs no socket infra, and degrades to TanStack Query polling (`refetchInterval` on non-terminal statuses) as fallback. WebSockets would be scope creep. **MVP simplification allowed:** ship polling first, add SSE in Phase 2 — the UI code is identical because TanStack Query owns the cache either way.

### 5.4 Upload flow (presigned, never proxy the bytes)

```
web ── POST /documents/uploads ──▶ api: create documents row (UPLOADED),
                                       presign PUT (content-type=application/pdf,
                                       max 10MB, key = docs/{uuid}.pdf)
web ── PUT file ─────────────────▶ S3/MinIO
web ── POST /documents/:id/complete ─▶ api: HEAD object, compute/verify sha256,
                                          reject >10MB or wrong magic bytes,
                                          status → QUEUED, enqueue extract job
```

Rationale: keeps large bodies off the API dyno, matches how you'd do it at scale, and gives a clean interview answer about direct-to-storage uploads. The `complete` step is the trust boundary — never trust the client's claim that the upload happened.

---

## 6. AI Workflow (the heart of the project)

### 6.1 Extraction schema (single source of truth)

`packages/domain/src/extraction/invoice-schema.ts`:

```ts
export const MoneyCents = z.number().int(); // minor units only

export const LineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPriceCents: MoneyCents,
  vatRatePercent: z.number().min(0).max(100),
  totalCents: MoneyCents,
});

export const InvoiceExtractionSchema = z.object({
  vendor: z.object({
    name: z.string().min(1),
    vatNumber: z.string().nullable(), // nullable, NOT optional — force the
    address: z.string().nullable(), // model to say "not present" explicitly
  }),
  invoiceNumber: z.string().min(1),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  currency: z.string().length(3),
  lineItems: z.array(LineItemSchema).min(1),
  subtotalCents: MoneyCents,
  vatTotalCents: MoneyCents,
  totalCents: MoneyCents,
  fieldConfidence: z.record(z.string(), z.number().min(0).max(1)),
});
```

Design choices worth defending in interviews:

- **`nullable()` not `optional()`** — an optional field lets the model silently omit things; nullable forces an explicit "this is absent" decision, which is a different (and detectable) failure mode than "I forgot".
- **Model self-reported confidence** per field (in `fieldConfidence`) is one signal, not the only one — see 6.4.
- The JSON Schema sent to the provider is **generated from this Zod schema** (`zod-to-json-schema`), so validation and generation can never drift.

### 6.2 Pipeline steps (worker)

```
Job: extract-document { documentId, contentSha256 }        (jobId = documentId → idempotent)

1. Guard: load document; if status ∉ {QUEUED} → log + ack (idempotency).
2. status → PROCESSING (event emitted)
3. Fetch PDF from S3 (stream).
4. PDF → text with `pdf-parse`/`unpdf`. If extracted text < ~50 chars/page →
   FAIL fast with reason 'LIKELY_SCANNED_IMAGE' (OCR is explicitly out of scope;
   this early rejection is also your cost-control story).
5. Truncate/segment: invoices are short; cap prompt input at ~8k tokens,
   keeping first + last pages if over (totals live at the end).
6. LLM extraction with corrective retry loop (6.3).
7. Business-rule validation in domain layer (6.5).
8. Confidence policy → flag fields (6.4).
9. Persist extraction + findings in ONE transaction with status transition:
   → NEEDS_REVIEW if any ERROR finding or any flagged field, else → COMPLETED.
10. Enqueue embed-document job (separate queue: cheaper model, different retry profile).
```

`embed-document`: chunk raw text (~500 tokens, 50 overlap) **plus one synthetic chunk built from the structured data** ("Invoice INV-233 from ACME S.r.l., 2026-03-12, total €1,240.50, items: …") — this synthetic chunk is what makes searches like "chairs from the Milan vendor" actually hit. Embed with `text-embedding-3-small` (1536 dims) or Voyage, insert chunks.

### 6.3 Structured output + corrective retry (the interview centerpiece)

```ts
// packages/ai — provider-agnostic port
interface LlmExtractor {
  extract(input: {
    text: string;
    schema: JsonSchema;
    feedback?: string;
  }): Promise<{ raw: unknown; usage: TokenUsage; model: string }>;
}

async function extractWithRepair(text: string): Promise<Result<Extraction, ExtractError>> {
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS /* 3 */; attempt++) {
    const { raw, usage } = await llm.extract({ text, schema, feedback });
    const parsed = InvoiceExtractionSchema.safeParse(raw);
    if (parsed.success) return ok({ data: parsed.data, attempt, usage });
    // Corrective feedback: feed the *specific* Zod issues back, not "try again"
    feedback = renderZodIssues(parsed.error); // "lineItems[1].totalCents must be an
    emitEvent('LLM_RETRY', { attempt, issues }); // integer, received 12.5" …
  }
  return err({ kind: 'SCHEMA_FAILURE', attempts: MAX_ATTEMPTS });
}
```

- Use the provider's native structured-output mode (Anthropic tool-use with `input_schema`, or OpenAI `response_format: json_schema, strict: true`) as the first line of defense; the Zod parse is the second (never trust, always verify — strict mode doesn't cover cross-field semantics).
- Temperature 0. Prompt versioned in `packages/ai/src/prompts/extract-invoice.v2.ts` and recorded on every extraction row — you can answer "how do you know a prompt change didn't regress quality?" with `SELECT avg(overall_confidence) GROUP BY prompt_version`.
- On final failure: document → FAILED with the accumulated issues in `failure_reason`. Never store unvalidated JSON as an extraction.

### 6.4 Confidence scoring & flagging policy (pure domain code)

Composite score per field, because self-reported LLM confidence alone is poorly calibrated:

```
fieldScore = min(
  llmSelfReport(field),                       // from fieldConfidence
  presenceScore(field),                       // 0.4 if value came back null on a required-ish field
  corroborationScore(field)                   // 1.0 if the literal value appears in source text
)                                             //   (exact/normalized substring match for numbers,
                                              //    dates, VAT ids — cheap and surprisingly effective)
flagged  = fieldScore < THRESHOLD (0.85, config)
overall  = weighted mean (totals & VAT weigh 2×)
```

The corroboration check is the differentiator: "does the extracted total literally appear in the document text?" catches hallucinated numbers deterministically, with zero extra tokens. Business-rule failures (6.5) additionally force `NEEDS_REVIEW` regardless of confidence.

### 6.5 Business rules (pure, unit-tested exhaustively)

| Rule             | Check                                                                | Severity        |
| ---------------- | -------------------------------------------------------------------- | --------------- |
| `LINE_ITEM_MATH` | `quantity × unitPriceCents ≈ totalCents` (±1 cent/line for rounding) | ERROR           |
| `LINE_ITEMS_SUM` | `Σ lineItems.totalCents == subtotalCents` (± len(items) cents)       | ERROR           |
| `VAT_ARITHMETIC` | `Σ per-rate VAT == vatTotalCents`; `subtotal + vat == total`         | ERROR           |
| `DATE_SANITY`    | issueDate ≤ today+1; dueDate ≥ issueDate; year ≥ 2000                | ERROR / WARNING |
| `VAT_ID_FORMAT`  | if present, matches country pattern (IT: `IT` + 11 digits)           | WARNING         |
| `CURRENCY_KNOWN` | ISO-4217 allowlist                                                   | WARNING         |

These live in `packages/domain` as pure functions `(extraction) → Finding[]`, take a `clock` parameter (no `new Date()` inside — testability), and use the `Money` value object. This table _is_ your test plan: every row gets passing + failing + boundary unit tests.

### 6.6 Cost control (Phase 2, but design for it in Phase 1)

1. **Early rejection**: unparseable/scanned/oversized PDFs never reach the LLM (step 4).
2. **Extraction cache**: `content_sha256` hit with same `prompt_version` + model → copy prior extraction, cost $0. (Seed data makes demo re-uploads free.)
3. **Model tiering**: default to a small model (Claude Haiku class); escalate the _same document_ to the mid-tier model only when the small model fails schema twice or overall confidence < 0.6. Record which tier served each doc.
4. **Token budgeting**: count tokens before send; hard cap per document; `cost_usd` computed from usage on every extraction — surface a running total on an admin card in the dashboard (30 minutes of work, disproportionate interview value).
5. **Prompt token reduction**: schema-by-tool-definition rather than schema-in-prose; strip PDF boilerplate (page headers repeated per page) before prompting.

---

## 7. Queue Design (BullMQ + Redis)

### 7.1 Queues & settings

| Queue        | Job                | Concurrency | Attempts | Backoff                      | Rationale                                               |
| ------------ | ------------------ | ----------- | -------- | ---------------------------- | ------------------------------------------------------- |
| `extraction` | `extract-document` | 2/worker    | 3        | exponential, 5s base, jitter | LLM rate limits; low concurrency keeps cost predictable |
| `embedding`  | `embed-document`   | 5/worker    | 5        | exponential 2s               | cheap + fast; can retry more aggressively               |

- **`jobId = documentId`** → BullMQ dedupes: re-enqueueing the same doc is a no-op. Combined with the status guard in the processor (process only if `QUEUED`), you get end-to-end idempotency — the standard answer to "what happens if the enqueue succeeds but the HTTP response is lost?".
- **Retry semantics split in two layers**: BullMQ attempts handle _transient_ failures (network, 429, 5xx from provider — thrown as retriable errors). The corrective-schema loop (6.3) is _inside_ one attempt and handles _semantic_ failures. Don't conflate them; this distinction is a great interview riff.
- **Rate limiting**: BullMQ limiter on `extraction` (e.g. 10 jobs/min) as a blunt guard against runaway spend; provider 429s additionally trigger backoff.
- **Dead letter**: after final attempt, `failed` event handler transitions document → FAILED with reason, emits event, increments a `jobs_failed_total` metric. Failed jobs kept 7 days (`removeOnFail: { age }`) for post-mortems; a small admin-only "requeue" endpoint flips FAILED → QUEUED.
- **Graceful shutdown**: worker `onModuleDestroy` closes the BullMQ `Worker` with `close()` (waits for in-flight job), 30s timeout; long LLM calls carry an `AbortSignal`. This is what makes `fly deploy` not strand documents in PROCESSING. Add a tiny **janitor cron** (BullMQ repeatable job): any document in PROCESSING > 15 min → back to QUEUED (attempt-capped).

### 7.2 Why a queue at all (the ADR)

HTTP timeout (30–60s at proxies) vs LLM latency (5–60s with retries) makes synchronous extraction fragile; a queue adds backpressure (uploads never slow down because extraction is busy), retry with backoff, horizontal scaling of workers independent of the API, and crash isolation. Cost: eventual consistency in the UI — solved by status polling/SSE. Write this as `docs/adr/0002-queue.md`.

---

## 8. Authentication & Security

### 8.1 Auth design

- **Access token**: JWT, 15 min, `sub`, `role`, signed HS256 with 256-bit secret (RS256 is scope creep for a single issuer/audience). Sent as `Authorization: Bearer`; stored in memory on the frontend (never localStorage).
- **Refresh token**: opaque 256-bit random, stored as **httpOnly, Secure, SameSite=Strict cookie** scoped to `/api/v1/auth`. Server stores only its SHA-256 hash.
- **Rotation with reuse detection**: every refresh issues a new token in the same `family_id` and marks the old one `replaced_by`. If a token that has already been replaced is presented → assume theft → **revoke the whole family**, force re-login, log a security event. This is the textbook-correct implementation and a guaranteed interview question.
- Passwords: **argon2id** (memory 19MiB, iterations 2) — not bcrypt; know why (memory-hardness vs GPU attacks).
- Next.js side: a thin route handler proxies login/refresh so the cookie is first-party; TanStack Query's fetch wrapper auto-refreshes on 401 once, then redirects to login.

### 8.2 Security checklist (Phase 1 unless marked)

- Input: Zod on every DTO; file upload constrained at presign time (content-type, size) **and** re-verified at `/complete` (magic bytes `%PDF-`).
- `helmet`, strict CORS (exact frontend origin), rate limiting (`@nestjs/throttler`: 10/min on auth routes, 100/min global).
- S3: private bucket, presigned GET expiry 5 min, keys are UUIDs (no user-controlled names → no path tricks).
- SQL injection: Prisma parameterizes; the one raw query (pgvector cosine search) uses `$queryRaw` tagged-template parameters — never string concatenation of the embedding.
- **Prompt-injection containment**: the PDF text is untrusted input. Structured-output mode + Zod means injected instructions can at worst corrupt _fields_ (caught by corroboration/rules), never trigger actions — the worker has no tools. Say this explicitly in the README; it's a sophisticated point.
- Secrets: env only, validated at boot (`packages/config`), never in the image; separate LLM API keys per environment with per-key spend limits at the provider (Phase 2).
- Audit: `document_events` + `review_decisions` give who-did-what.
- Dependency hygiene: `pnpm audit` + Dependabot in CI (Phase 2: fail CI on high severity).

---

## 9. Frontend (Next.js 15, App Router)

### 9.1 Structure & principles

- **Server Components for shells, Client Components for live data.** Auth-gated layout reads the session server-side; the documents table, status badges, and review form are client components under TanStack Query (v5) because they poll/mutate.
- API client generated by hand in `web/lib/api.ts` from `packages/contracts` Zod types (`z.infer`) — end-to-end type safety without codegen tooling overhead.
- Tailwind + a small set of shadcn/ui primitives (table, dialog, badge, toast). Resist a component-library safari.

### 9.2 Screens (MVP — exactly four)

1. **Login** — demo credentials pre-filled from env (`DEMO_EMAIL`) for the 90-second demo.
2. **Documents list** — upload dropzone (direct-to-S3 flow with progress), table with status badges, confidence bar, cost, filters by status; rows with non-terminal status poll every 2s (or subscribe SSE in Phase 2).
3. **Review detail** — the money screen: left pane PDF (`react-pdf`/pdf.js via the presigned URL), right pane the extracted fields grouped (vendor / meta / line-items table / totals). Flagged fields get an amber outline + confidence tooltip; failed rules render as a findings banner ("Line items sum to €1,240.00 but total is €1,250.00"). Inline edit → optimistic update → `POST /review` (server re-validates rules; if corrected data still fails ERROR rules, the save is rejected with the findings — the backend is the authority). Approve / Reject buttons.
4. **Search** — single input, debounced; results as cards: document, matching snippet (highlighted), similarity score, link to detail.

Plus a small header stat strip: docs processed, % auto-approved, total LLM spend. Cheap, demos wonderfully.

### 9.3 UX details that read as "senior"

- Empty states, loading skeletons, and error toasts everywhere — three states per query, no exceptions.
- Upload validates PDF + ≤10MB client-side _and_ trusts only the server.
- Status badge colors map 1:1 to the state machine; FAILED shows `failure_reason`.
- Keyboard: `A` approve, `E` first flagged field — reviewers live on keyboards.

---

## 10. Testing Strategy

The pyramid, with the LLM problem solved explicitly:

```
        Playwright smoke (3 flows)          ← e2e, runs against docker-compose stack
      API integration (Testcontainers)      ← real Postgres+pgvector, real Redis,
                                               FixtureLlmExtractor, MinIO or S3-mock
    Contract tests (real LLM, separate CI job, non-blocking nightly)
  Unit tests (domain + ai packages)         ← hundreds, milliseconds, no I/O
```

### 10.1 Unit (Vitest, `packages/domain`, `packages/ai`)

- Every business rule from the 6.5 table: pass, fail, boundary (±1 cent rounding, dueDate == issueDate, leap dates). Inject `clock`.
- Confidence policy: table-driven tests over (selfReport, presence, corroboration) → flagged.
- State machine: full transition matrix (legal + illegal).
- `renderZodIssues` and the retry loop with a stub extractor programmed to fail-then-succeed; assert feedback content and attempt counts.
- Money value object arithmetic.

### 10.2 Recorded LLM fixtures (the portfolio differentiator)

- `FixtureLlmExtractor implements LlmExtractor` reads JSON from `packages/ai/src/fixtures/` keyed by scenario: `clean-invoice`, `missing-vat-number`, `sum-mismatch`, `malformed-json-then-valid` (multi-response fixture driving the retry path), `hallucinated-total` (corroboration catches it), `scanned-image-garbage`.
- A `record-fixtures` script hits the real API with the sample PDFs and writes responses (with usage) to disk — fixtures are _real recorded outputs_, refreshed deliberately, committed to git. Document the refresh procedure in the README.
- Integration tests inject `FixtureLlmExtractor` via Nest DI — the entire pipeline (queue → worker → validation → persistence → status) runs for real with zero network and zero cost.

### 10.3 Integration (Testcontainers, `apps/api` + `apps/worker`)

Spin real `pgvector/pgvector:pg16` and `redis:7` containers per suite; run Prisma migrations; boot both Nest apps in-process. Core scenarios:

1. Upload complete → job → COMPLETED with correct extraction persisted (clean fixture).
2. Sum-mismatch fixture → NEEDS_REVIEW + `LINE_ITEMS_SUM` finding → correction via `/review` → COMPLETED, extraction v2, decision recorded.
3. Malformed-then-valid fixture → succeeds with `attempts = 2`, `LLM_RETRY` event present.
4. Duplicate upload (same sha) → dedupe/cache path, no second LLM call (assert fixture call count).
5. Auth: rotation happy path + **reuse-detection revokes family**.
6. Search: seed two known docs, query, assert ordering by cosine score (embed queries with a deterministic fake embedder in tests — hash-based vectors — so ordering is stable).
7. Worker crash simulation: kill mid-job, janitor requeues, completes (Phase 2).

### 10.4 Contract tests (real LLM)

Nightly + manual-dispatch GitHub Actions job, **not** on PRs: run the 5 sample PDFs against the live provider, assert schema-parse success rate == 100% and business-rule pass rate ≥ threshold. Catches provider drift/model deprecations without making CI flaky or expensive. This split — deterministic fixtures for PRs, real API on a schedule — is _the_ answer to "how do you test non-determinism".

### 10.5 e2e (Playwright)

Three smoke flows against the composed stack (fixture LLM): login→upload→see COMPLETED; open flagged doc→correct→approve; search→open result. Runs in CI on `main` only.

---

## 11. CI/CD (GitHub Actions)

### 11.1 `ci.yml` (every PR)

```
jobs:
  quality:   pnpm install (cached) → turbo run lint typecheck → dependency-boundary check
  unit:      turbo run test:unit  (affected-only via turbo cache)
  integration:
             services: none — Testcontainers manages its own (needs docker)
             turbo run test:integration
  build:     turbo run build → docker build (multi-stage, layer-cached via GHA cache)
  e2e (main only): docker compose -f infra/docker-compose.test.yml up → playwright
```

Branch protection on `main`: PR + green checks required. Conventional commits + `changesets` optional but cheap credibility.

### 11.2 `deploy.yml` (push to main)

1. Build once, push image to GHCR tagged `sha`.
2. Deploy to Railway/Fly: **migrations run as a release command** (`prisma migrate deploy`) before new instances receive traffic — never on app boot.
3. Deploy `api` and `worker` services from the same image (different start commands), then `web`.
4. Post-deploy smoke: hit `/health/ready`, run one canary search request.
5. Rollback: redeploy previous image tag (document the command in the README runbook).

### 11.3 `contract.yml`

Nightly cron → real-LLM contract tests → on failure, opens a GitHub issue automatically.

---

## 12. Observability & Error Handling

### 12.1 Errors

- Domain returns `Result<T, DomainError>` — expected failures (rule violations, schema failure after retries) are **values**, not exceptions. Exceptions are reserved for bugs and infrastructure faults.
- API: one global exception filter maps `DomainError` subtypes → the RFC-7807 envelope + correct status (422 validation, 404, 409 illegal transition, 401/403). Unknown errors → 500 with `traceId`, details only in logs.
- Worker: classify errors as `Retriable` (429/5xx/network → throw so BullMQ retries) vs `Terminal` (schema exhaustion, scanned PDF → mark FAILED, ack). One `classifyError()` function, unit-tested.

### 12.2 Logging & tracing

- **pino** everywhere, JSON to stdout; `traceId` propagated HTTP → job payload → worker logs, so one grep reconstructs a document's life. Redact: auth headers, tokens, and **raw LLM prompt/response bodies at info level** (log token counts + hash; full bodies only at debug in dev — invoices are PII-ish).
- **OpenTelemetry (Phase 2)**: auto-instrument Nest + Prisma + BullMQ, manual spans around `llm.extract` with attributes `model, attempt, input_tokens, cost_usd`. Export to Grafana Cloud free tier or Honeycomb free tier. One trace showing upload→queue→LLM(retry)→persist is a killer screenshot for the README.

### 12.3 Metrics & alerting (Phase 2)

`prom-client` `/metrics` (or OTel metrics): `documents_processed_total{status}`, `llm_attempts_histogram`, `llm_cost_usd_total`, `queue_depth`, `job_duration_seconds`, `flagged_fields_ratio`. Alerts (even just to email): queue depth > 50 for 10 min; failure ratio > 20%/h; daily LLM spend > cap. A tiny Grafana dashboard JSON committed to `infra/`.

### 12.4 Health

`/health/live` (process up) vs `/health/ready` (pg `SELECT 1`, redis PING, S3 HEAD bucket) via `@nestjs/terminus`; worker exposes readiness via a heartbeat key in Redis that the API health check reads.

---

## 13. Infrastructure & Deployment

### 13.1 Local (`infra/docker-compose.yml`)

Services: `postgres` (`pgvector/pgvector:pg16`), `redis:7-alpine`, `minio` + one-shot `minio-setup` (creates bucket + credentials), `api`, `worker`, `web` — the last three with hot-reload bind mounts for dev. One command onboarding: `pnpm setup` → `docker compose up -d postgres redis minio && prisma migrate dev && pnpm seed && turbo dev`. If the README quickstart is longer than five lines, fix the tooling, not the README.

### 13.2 Dockerfile (one, multi-stage)

```
base    → node:22-alpine + pnpm (corepack)
deps    → pnpm fetch (lockfile-only layer, maximal cache)
build   → turbo run build (api, worker) + prisma generate
runtime → distroless-ish alpine, non-root user, only dist + prod deps
          api:    CMD ["node", "apps/api/dist/main.js"]
          worker: CMD ["node", "apps/worker/dist/main.js"]   (override per service)
web     → separate stage using next build standalone output
```

### 13.3 Production topology (Railway — pick it over Fly for the managed Postgres/Redis simplicity; document the tradeoff in an ADR)

- `api` (1× 512MB), `worker` (1× 512MB), `web` (Next standalone), managed Postgres (enable pgvector), managed Redis, AWS S3 (real S3 in prod — eu-south-1 Milan region is a nice touch for the Italian-market narrative), all env via Railway secrets.
- Custom domain + HTTPS (platform-provided). Seed job runs `pnpm seed:demo` — 8 varied invoices (clean, flagged, failed, duplicate) + demo user, so the dashboard is never empty.
- Cost ceiling: ~$10–15/month + LLM (< $2/month with Haiku-class + cache). Set a provider spend cap.

### 13.4 Scalability story (know it; build only the first line)

| Bottleneck            | First move                                                                                                           | Later                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Extraction throughput | scale worker replicas (BullMQ concurrency is per-worker; jobs are single-doc + idempotent, so horizontal is trivial) | provider rate-limit aware global limiter           |
| API                   | stateless → replicas behind LB                                                                                       | —                                                  |
| Postgres              | indexes already in place; read pressure is tiny                                                                      | read replica; partition `document_events` by month |
| pgvector              | HNSW fine to ~1M chunks                                                                                              | dedicated vector store only if proven necessary    |
| S3                    | already infinite                                                                                                     | lifecycle rule → IA after 90 days                  |
| LLM cost              | cache + tiering (6.6)                                                                                                | batch API for backfills (50% discount)             |

The honest answer "this design scales by adding worker replicas and nothing else needs to change until ~100k docs/month" is stronger than speculative microservices.

---

## 14. Key Technical Decisions (ADR summary — write each as a one-pager in `docs/adr/`)

| #   | Decision                                                      | Alternatives                     | Why                                                                                                                                 |
| --- | ------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Modular monolith, 2 processes (api+worker)                    | microservices; single process    | crash/scale isolation for LLM work without distributed-system tax                                                                   |
| 2   | pnpm + Turborepo monorepo                                     | polyrepo                         | shared Zod schemas FE↔BE↔worker; one CI; demo-ability                                                                               |
| 3   | Prisma                                                        | TypeORM, Drizzle, Kysely         | best migration DX + types; raw SQL escape hatch covers pgvector. Drizzle is a defensible alternative — pick one and own it          |
| 4   | Zod everywhere (nestjs-zod)                                   | class-validator                  | one schema language: extraction schema, DTOs, env, FE types all from the same source                                                |
| 5   | BullMQ                                                        | pg-boss, SQS                     | Redis already needed; mature retry/rate-limit/repeatable APIs; pg-boss is the "fewer moving parts" counterargument — acknowledge it |
| 6   | pgvector (HNSW)                                               | Pinecone/Qdrant                  | data gravity: joins with relational workflow state, one backup story, zero extra infra                                              |
| 7   | Presigned direct upload                                       | proxy through API                | memory/timeout safety; production-realistic                                                                                         |
| 8   | SSE (Phase 2) over WebSockets, polling first                  | WS                               | one-directional need; infra simplicity                                                                                              |
| 9   | Structured outputs + Zod re-validation + corrective retry     | prompt-and-pray; regex repair    | layered defense; measurable (attempts column)                                                                                       |
| 10  | Composite confidence (self-report ∧ presence ∧ corroboration) | trust the model                  | self-reported confidence is uncalibrated; substring corroboration is free hallucination detection                                   |
| 11  | Cents-integer money + Money VO                                | floats/decimal.js in JSONB       | correctness; ±1-cent rounding tolerance is an explicit business rule                                                                |
| 12  | Argon2id + refresh rotation w/ family reuse detection         | bcrypt, static refresh           | current OWASP guidance; theft detection                                                                                             |
| 13  | Fixtures for CI, real-LLM contract tests nightly              | mock everything or hit API in CI | deterministic PRs + drift detection                                                                                                 |
| 14  | Railway                                                       | Fly.io, AWS ECS                  | managed pg/redis, lowest ops for a portfolio; Fly noted as equal alternative                                                        |

---

## 15. Phase-by-Phase Build Order (step-by-step, no gaps)

### Phase 0 — Foundations (Week 1)

1. Repo scaffold: pnpm workspaces, Turborepo, tsconfig/eslint/prettier presets in `packages/config`, boundary lint rule.
2. `docker-compose.yml` with postgres+pgvector, redis, minio; `packages/config` env schema.
3. Prisma init in `packages/database`: users, documents, document_events only; first migration; seed script skeleton.
4. NestJS `api` skeleton: health module, global exception filter, pino, traceId middleware. `worker` skeleton consuming a `noop` job.
5. Next.js skeleton: layout, login page shell.
6. `ci.yml`: lint + typecheck + unit (empty is fine) + docker build. **Walking skeleton deployed to Railway by end of week** — deploying early de-risks everything.

### Phase 1 — MVP (Weeks 2–6)

**Week 2 — Auth + upload.** 7. Auth module: register/login/refresh/logout, argon2id, rotation + family reuse detection, guards, throttler. Integration tests for rotation/reuse. 8. Presigned upload flow: `POST /uploads`, `POST /:id/complete` (HEAD, sha256, magic bytes, dedupe), state machine + events in domain. FE: login + dropzone + documents table (polling).

**Week 3 — Extraction pipeline.** 9. `packages/domain`: invoice schema, Money, business rules, confidence policy — **with full unit suites before any wiring**. 10. `packages/ai`: `LlmExtractor` port, Anthropic adapter (structured outputs), `extractWithRepair`, token/cost accounting, `FixtureLlmExtractor`, record-fixtures script + 5 sample PDFs (make them yourself: clean, missing VAT id, sum mismatch, long multi-page, garbage/scanned). 11. Worker processor: full pipeline (steps 1–9 of 6.2), transactional persistence, error classification, dead-letter handling. Integration tests scenarios 1–4.

**Week 4 — Review dashboard.** 12. `GET /documents/:id` aggregate endpoint; `POST /review` with server-side re-validation and extraction v2. 13. FE review screen: PDF pane, fields pane, flag styling, findings banner, inline edit + optimistic mutation, approve/reject, keyboard shortcuts. Playwright flow 2.

**Week 5 — Search + export.** 14. Embedding job: chunker (+ synthetic structured chunk), embedding adapter (+ deterministic fake for tests), pgvector insert, `$queryRaw` cosine search endpoint. FE search page. Integration test 6. 15. Export: streamed CSV (flatten line items: one row per line item with document columns repeated — state this choice in the README) and JSON; filters.

**Week 6 — Polish + ship.** 16. Seed demo data (8 docs across all states), demo login, empty/loading/error states audit, stat strip, README (architecture diagram, quickstart, **Known limitations**, fixture-refresh runbook), `deploy.yml` with release-phase migrations, Playwright suite green in CI. **MVP demo-ready.**

### Phase 2 — Production hardening (Weeks 7–8)

17. SSE status stream (Redis pub/sub) with polling fallback.
18. Cost controls: extraction cache, model tiering, rate limiter, spend metric + dashboard card, provider spend cap.
19. OTel tracing + prom metrics + Grafana dashboard JSON + 3 alerts; janitor cron for stuck PROCESSING docs; requeue endpoint; worker crash integration test.
20. Security pass: dependency audit gating, secret scanning (gitleaks action), CSP on the web app, pen-test yourself with the OWASP API top 10 as a checklist; write findings in `docs/security-review.md`.
21. Contract-test workflow (nightly real-LLM) + auto-issue on failure.
22. Load sanity: `k6` script — 50 concurrent uploads with fixture LLM; verify queue drains, no state corruption; record numbers in README.

---

## 16. Explicitly Out of Scope (write these in the README as "Known limitations")

Multi-tenancy · billing · OCR for scanned/imaged PDFs (early-rejected with a clear failure reason instead) · mobile app · real-time collaboration · notifications/email · fine-tuning or custom models · analytics/reporting · i18n (though sample invoices include Italian-language ones — the extraction handles them; the _UI_ is English-only).

Each line item in that README section should say _why_ it's out and what the seam for adding it would be (e.g., "multi-tenancy: add `tenant_id` to documents + RLS; all queries already go through repositories, so it's a bounded change"). Naming the seam is what turns a limitation into evidence of architectural judgment.

---

## 17. The 90-Second Demo Script (build toward this from day one)

1. Open live URL → login pre-filled → dashboard with seeded history and the spend/auto-approval stat strip. _(10s)_
2. Drag in the "sum mismatch" sample PDF → status badge animates QUEUED → PROCESSING → NEEDS_REVIEW. _(25s)_
3. Open it: PDF left, fields right, total flagged amber, findings banner explains the €10 discrepancy. Fix one field inline → rules re-run → approve → COMPLETED. _(30s)_
4. Search "sedie ufficio Milano" → the right invoice surfaces with a highlighted snippet. _(15s)_
5. Export CSV. Mention: "every PR runs the full pipeline against recorded LLM fixtures in Testcontainers; the real API is contract-tested nightly." _(10s)_

If any step of this script is janky, fixing it outranks any new feature. That priority rule is your scope-creep firewall.
