# InvoiceIQ

**PDF invoice → LLM structured extraction → validation → human review → semantic search.**

A production-shaped document extraction pipeline. The interesting problem is not
calling a model — it is everything around the call: making a non-deterministic
component safe to build on, deciding when a human is needed, and proving it all
works without spending money on every test run.

```
Next.js 16 ──HTTPS──▶ NestJS API ──enqueue──▶ Redis / BullMQ ──▶ NestJS Worker
                          │                                          │
                          ├── presigned PUT ──▶ S3 / MinIO ◀─────────┤
                          └── SQL ──▶ PostgreSQL 16 + pgvector ◀─────┘
                                                                     │
                                                          Anthropic (tool-use)
```

Two deployable processes from one image, one codebase. The API never calls the
LLM; every expensive step is a queued, idempotent, retriable job.

---

## Quickstart

```bash
pnpm install && pnpm bootstrap    # datastores, migrations, demo accounts
```

```bash
./scripts/dev-stack.sh start && pnpm --filter @invoiceiq/web dev
```

```bash
pnpm seed:demo                    # six invoices covering every outcome
```

Open http://localhost:3000 — demo credentials are pre-filled.

**No API key is required.** With `LLM_PROVIDER=fixture` (the default) the whole
pipeline runs against recorded model output, and embeddings run on a local
multilingual model. Set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic` to go
live.

---

## What is actually interesting here

### Determinism at the boundary of non-determinism

The LLM is the only non-deterministic component. Everything around it is
deterministic and unit-tested, and the boundary is defended in layers:

1. **Tool-use with a generated schema.** The JSON Schema handed to the model is
   generated from the Zod schema, so the prompt and the validator cannot drift.
2. **Zod re-validation.** Never trust, always verify — strict mode cannot
   express "integer minor units" and says nothing about cross-field semantics.
3. **A corrective retry loop.** On a parse failure the _specific_ Zod issues are
   fed back, not a bare retry. At temperature 0 an identical prompt reproduces
   an identical failure, so "try again" is just a slower way to fail.

BullMQ retries and the repair loop are deliberately separate. Provider failures
(429, 5xx) stop the loop and hand the decision to the queue; schema failures are
repaired in-process. Conflating them would make a malformed reply wait five
minutes for a backoff it does not need.

### Deciding when a human is needed

Three signals, combined with `min()` rather than an average:

| Signal            | Catches                                     |
| ----------------- | ------------------------------------------- |
| Model self-report | Fields the model itself doubts              |
| Presence          | An expected field returned null             |
| **Corroboration** | **A value that appears nowhere in the PDF** |

Averaging would launder the failure that matters most: a total the model is 99%
sure of that appears nowhere in the document is not 65% trustworthy, it is
wrong. Corroboration tokenises every number in the source into minor units, so
`€1.240,50` and `1,240.50` compare equal.

Separately, six business rules recompute the arithmetic. Schema validity is not
correctness — a perfectly-shaped invoice whose lines sum to €1,240 against a
stated €1,250 is caught here, deterministically, at zero token cost.

### Not paying twice for the same answer

Three controls, each aimed at a different way spend runs away:

| Control                                                   | Stops                                                   |
| --------------------------------------------------------- | ------------------------------------------------------- |
| **Extraction cache** on `(sha256, prompt version, model)` | Paying again for bytes already extracted                |
| **Model tiering**, escalating on a schema failure         | Paying Sonnet prices for invoices Haiku reads correctly |
| **Daily cap**, read from the database                     | A retry loop billing all night                          |

Escalation triggers on a _schema_ failure, never on low confidence. A stronger
model can plausibly fix malformed output; it will just as confidently agree with
a doubtful number, so paying twice to learn nothing is the wrong move — that
case belongs to a human, which is what the review queue is for.

The cache stores only the **model output**. Validation, confidence and chunking
re-run from scratch on a hit, because they are pure, free, and the parts most
likely to have changed since the row was written. Caching the verdict would mean
a tightened business rule silently did not apply to duplicate uploads.

### When a worker dies

Graceful shutdown drains in-flight jobs, so the ordinary case is covered. For
SIGKILL and OOM there is a janitor: a **BullMQ repeatable job**, not an
in-process cron, because Redis elects one runner where `@nestjs/schedule` would
race N replicas against the same rows.

Reclaiming is safe in both directions regardless — the processor refuses any
document that is not `QUEUED`, so a job arriving for work someone else picked up
acknowledges itself and does nothing.

### Testing a non-deterministic system

```
Playwright smoke              ← against the composed stack
Integration (Testcontainers)  ← 124 tests: real Postgres, Redis, MinIO
Contract tests (nightly)      ← real API, off the PR path
Unit (domain + ai + worker)   ← 450 tests, milliseconds, no I/O
```

Every PR runs the **real worker** — real queue, real transactions, real
validation — against recorded model output. Only the network call is replaced,
because it costs money and returns something different every time.

The fixtures are asserted against the sample PDFs they describe, so a scenario
named `sum-mismatch` whose numbers happen to add up fails the build. That check
exists because it caught a real bug: a fixture carrying dates absent from its
own PDF, which made the review screen show amber warnings on correct fields.

---

## Design decisions worth defending

| Decision                           | Why                                                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cents as integers, never floats    | `0.1 + 0.2 !== 0.3`. `Money.times()` rounds half **away from zero**, not `Math.round`, which rounds half toward +∞ and would make a credit note disagree with its invoice by a cent.      |
| `.nullable()`, never `.optional()` | An optional field lets the model silently omit what it could not find. Nullable forces an explicit "absent" — a different, detectable failure mode.                                       |
| Presigned direct upload            | 10 MB bodies never touch the API process. `/complete` is the trust boundary: the server re-reads the object and checks the `%PDF-` magic bytes.                                           |
| Corrections create version 2       | v1 is kept so "how often was the model wrong, and about what?" stays answerable.                                                                                                          |
| Server re-validates corrections    | A reviewer can mistype a total. A UI that accepts it because nothing rendered red would silently approve a wrong invoice for payment.                                                     |
| Keyset pagination                  | A document completing between page 1 and 2 would make offset pagination skip or repeat rows.                                                                                              |
| Refresh rotation + reuse detection | Replaying a rotated token proves two parties hold a single-use secret, so the whole family is revoked. Reuse is checked _before_ expiry — otherwise an attacker just waits out the clock. |

Full rationale in [`docs/adr/`](docs/adr/) — thirteen of them, each with a
"what this cost us" section, because a decision record that lists only benefits
is advertising.

### Prompt injection

The PDF text is untrusted input and no prompt wording reliably prevents
injection. The defence is architectural: the model has **no tools**, so it
cannot act; its output is schema-constrained and re-validated; and its numbers
are corroborated against the document. The worst an injected instruction
achieves is a wrong field value — which is precisely what the confidence policy
and business rules exist to catch.

---

## Known limitations

Each names the seam for fixing it, because a limitation with a known fix is a
scoping decision rather than an oversight.

- **Cross-language search is weak.** A 384-dimension MiniLM bridges English
  queries to Italian invoices only marginally: "chairs" reaches the _Sedie
  ufficio_ invoices, but "chairs from the Milan vendor" does not rank them
  first. _Seam:_ `EmbeddingProvider` has an OpenAI adapter; switching is a
  config change plus a migration, since 1536 dimensions need a new column.
- **No OCR.** Scanned PDFs are rejected early with `LIKELY_SCANNED_IMAGE` rather
  than sent to the model to hallucinate from. _Seam:_ the rejection is one
  branch in `extractPdfText`; an OCR step slots in ahead of it.
- **Single tenant.** _Seam:_ add `tenant_id` to documents and enable RLS. Every
  query already goes through a repository scoped by uploader, so the change is
  bounded.
- **Live updates are best-effort.** Status changes arrive over SSE, but Redis
  pub/sub has no delivery guarantee — an event published while a browser was
  disconnected is simply gone. The database stays the source of truth and the
  dashboard keeps a slow poll as the fallback, which is why the header says
  "Live" or "Reconnecting" rather than pretending there is no difference.
- **Prisma cannot express pgvector.** The embedding column is `Unsupported`, so
  inserts and search are raw SQL confined to two files. A generated migration
  will silently `DROP` the HNSW index — `schema-integrity.integration.test.ts`
  fails CI if it does.
- **No fine-tuning, billing, notifications, i18n, or analytics.** Out of scope
  by choice.

---

## Running the tests

```bash
pnpm test:unit          # 420 tests, no Docker, under a second
```

```bash
pnpm test:integration   # Testcontainers: real Postgres, Redis, MinIO
```

```bash
pnpm boundaries:verify  # architecture rules — and a test that they can fail
```

```bash
k6 run infra/load/upload-burst.js   # 50 concurrent uploads
```

`boundaries:verify` injects a deliberate `packages/domain → @nestjs/common`
import and asserts the check rejects it. A boundary config that passes proves
nothing unless you also prove it can fail.

### Load

The load script answers one question: when fifty people upload at once, does
queue pressure reach the request path? Measured on a laptop against the local
stack, with the per-IP limiter raised for the run:

|                                  |                            |
| -------------------------------- | -------------------------- |
| Uploads accepted                 | 50 / 50, zero errors       |
| Dashboard reads during the burst | 300 / 300, **p95 10.8 ms** |
| Failed requests                  | 0 of 451                   |

The reads are the assertion; the uploads are only the load that makes it
meaningful. It is deliberately not a throughput benchmark — throughput here is
set by `EXTRACTION_RATE_LIMIT_PER_MINUTE` and the provider, both configuration,
so measuring it would produce an impressive number that means nothing.

Raising the limiter first is not cheating, it is the point: throttling is
per-IP and every virtual user shares one address, so at the shipped default the
run measures the throttler rather than the system behind it. The script says so
in its header, because the first version of it did exactly that and reported 88%
"failure" that was entirely the limiter working as designed.

### Refreshing the LLM fixtures

The committed fixtures are hand-authored, because this project was built without
an API key. To replace them with genuine recordings:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @invoiceiq/ai record:fixtures
```

Review the diff before committing — every downstream test believes these values.

---

## Repository layout

```
apps/
  api/        NestJS HTTP: auth, upload, review, search, export
  worker/     NestJS standalone: extraction and embedding processors
  web/        Next.js App Router
packages/
  domain/     THE HEART. Pure TS, zero framework imports, 309 tests
  contracts/  Zod schemas shared by API, worker and browser
  ai/         LlmExtractor port, adapters, repair loop, fixtures
  database/   Prisma schema, migrations, seed
```

`packages/domain` may import **only** zod. Enforced by dependency-cruiser in CI,
not by convention.

---

## Operations

```bash
./scripts/dev-stack.sh {start|stop|restart|status|logs}
```

Manages the API and worker with pid files. It exists because doing it by hand
went wrong: `pkill -f "worker/dist/main.js"` never matches a process running
`node dist/main.js`, and seven stale workers consuming one queue produced
results that looked exactly like a subtle concurrency bug in the pipeline.

### Observability

The worker exposes `/metrics` on a private port (9464 by default). The API's is
behind a bearer token and **404s when that token is unset** — it is the process
with a public origin, and a metrics endpoint that ships open publishes request
volumes, error rates and spend to anyone who guesses the path.

[`infra/observability/`](infra/observability/) has a Grafana dashboard and four
alert rules. The dashboard is ordered by the questions an incident actually
raises, in order: is work moving, is it correct, is it slow, what is it costing.

Metric names live in `packages/observability` rather than in each app, for the
same reason the embedding settings are shared: if the worker exported
`extraction_total` and the API exported `extractions_total`, every dashboard
would still render, showing half the truth, with nothing anywhere reporting an
error.

### Security

[`docs/security-review.md`](docs/security-review.md) is a pass over the OWASP API
Top 10 plus the two risks specific to putting a model in the pipeline. It is
written to be checkable: each item names the file the control lives in, and the
gaps — no MFA, `'unsafe-inline'` in the CSP, no row-level security — are listed
as gaps rather than as future work.

CI gates on `gitleaks` over the **full history** (a secret "removed" in a later
commit is still in the pack file) and `pnpm audit --audit-level high`. The audit
passed on its first run because the seven advisories it found were fixed by
pinning in `pnpm.overrides`, not added to an ignore list — which would have made
the gate decorative on day one.
