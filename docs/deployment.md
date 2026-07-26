# Deploying to Railway

A checklist, not automation. Account creation and secrets are yours — no CI job
should be able to create infrastructure or read your credentials.

Budget roughly **$10–15/month** plus LLM spend (under $2/month on a Haiku-class
model with the extraction cache).

---

## 1. Provision

In a new Railway project, add:

| Service        | Notes                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL** | After it starts, run `CREATE EXTENSION IF NOT EXISTS vector;` in the Railway query console. Migrations expect it. |
| **Redis**      | No configuration needed.                                                                                          |
| **api**        | Deploy from GitHub. Start command `node apps/api/dist/main.js`.                                                   |
| **worker**     | Same repo, same image. Start command `node apps/worker/dist/main.js`.                                             |
| **web**        | Same repo. Start command `pnpm --filter @invoiceiq/web start`.                                                    |

Object storage is **not** on Railway. Create an S3 bucket (eu-south-1 / Milan
suits the Italian-market framing) with:

- public access fully blocked — every read goes through a presigned URL;
- an IAM user limited to `GetObject`, `PutObject` and `HeadBucket` on that
  bucket alone.

## 2. Configure

Shared by **api** and **worker**:

```
DATABASE_URL      ${{Postgres.DATABASE_URL}}
REDIS_URL         ${{Redis.REDIS_URL}}
S3_ENDPOINT       https://s3.eu-south-1.amazonaws.com
S3_REGION         eu-south-1
S3_BUCKET         your-bucket-name
S3_ACCESS_KEY_ID  …
S3_SECRET_ACCESS_KEY …
S3_FORCE_PATH_STYLE  false        # MinIO needs path style; real S3 does not
NODE_ENV          production
```

**api** only:

```
JWT_SECRET     <openssl rand -hex 32>
CORS_ORIGIN    https://your-web-domain
DEMO_EMAIL     demo@invoiceiq.dev
DEMO_PASSWORD  <something you are willing to publish>
```

**worker** only — omit both to run on recorded fixtures at zero cost:

```
LLM_PROVIDER       anthropic
ANTHROPIC_API_KEY  sk-ant-…
```

**web**:

```
NEXT_PUBLIC_API_URL  https://your-api-domain
```

> `JWT_SECRET` must be generated, not copied from `.env.example`. That file
> ships a placeholder precisely so an unedited value cannot be mistaken for a
> real one.

Set a **spend cap** in the Anthropic console. A runaway loop is the one failure
mode this architecture cannot bound on its own.

## 3. Enable the deploy workflow

In GitHub → Settings:

- Variables: `DEPLOY_ENABLED=true`, `APP_URL=https://your-api-domain`
- Secrets: `RAILWAY_TOKEN`, `DATABASE_URL`

Until `DEPLOY_ENABLED` is set the deploy job is skipped, so the workflow is
harmless on a fork or before infrastructure exists.

## 4. Seed

```bash
DEMO_EMAIL=demo@invoiceiq.dev DATABASE_URL=<railway url> pnpm db:seed
```

```bash
API_URL=https://your-api-domain pnpm seed:demo
```

The first creates the accounts; the second pushes six invoices through the real
API so the dashboard is never empty.

---

## Runbook

**Roll back.** Railway keeps previous deployments — redeploy the last good one
from the service's Deployments tab, or:

```bash
railway redeploy --service api --deployment <id>
```

Migrations are **not** rolled back automatically. Every migration so far is
additive, so an older image runs against a newer schema safely. A destructive
migration would need a paired down-migration written deliberately.

**A document is stuck in PROCESSING.** A worker died mid-job. The timeline on
the review screen shows where it stopped. Until the M11 janitor lands, requeue
by setting the status back to `QUEUED`; the processor's status guard makes that
safe.

**Extraction is failing across the board.** Check `LLM_PROVIDER` and the key
first. `failure_reason` carries a machine-readable prefix —
`LIKELY_SCANNED_IMAGE`, `SCHEMA_FAILURE`, `LLM_REQUEST_REJECTED` — so:

```sql
SELECT split_part(failure_reason, ':', 1) AS code, count(*)
FROM documents WHERE status = 'FAILED' GROUP BY 1 ORDER BY 2 DESC;
```

**Search returns nothing sensible.** Almost always the API and worker
disagreeing on `EMBEDDING_PROVIDER`. Different models put queries in a different
vector space than documents, and nothing errors.

**Cost check.**

```sql
SELECT prompt_version, count(*), round(sum(cost_usd), 4) AS total,
       round(avg(overall_confidence), 3) AS avg_confidence
FROM extractions GROUP BY 1;
```

Grouping by `prompt_version` is why prompts are versioned: it answers "did that
prompt change make quality worse?" with data.
