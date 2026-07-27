# Security review

A pass over the [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/),
plus the two risks specific to putting a language model in the middle of a
pipeline.

This is a self-assessment of a portfolio project, not a penetration test. It is
written to be _falsifiable_: each item names where the control lives so a reader
can check the claim, and the gaps are listed as gaps rather than as future work.

---

## API1:2023 — Broken object level authorization

**Addressed.** Every query is scoped by owner at the repository boundary, not by
a check the caller may forget: `findOwned(userId, documentId)` in
[`documents.service.ts`](../apps/api/src/modules/documents/documents.service.ts)
filters on `uploaderId` in the `WHERE` clause. There is no code path that loads
a document by id alone and then checks ownership afterwards, which is the shape
that produces IDOR when someone adds a route and forgets the second half.

A document belonging to another user returns **404, not 403**. A 403 confirms
the id exists, turning the endpoint into an oracle for enumerating them.

Covered by tests in every module: search, export, review and requeue each have a
"never returns another user's documents" case.

**The one deliberate exception** is the extraction cache, which looks up by
content hash without filtering on uploader
([`extraction-cache.service.ts`](../apps/worker/src/pipeline/extraction-cache.service.ts)).
A hit requires byte-identical content, so the requesting user already holds
every byte the cached extraction was derived from — it is a pure function of
bytes they uploaded themselves. The lookup is pinned to `version: 1` so a
reviewer's _corrections_, which are judgement rather than derivation, are never
reused across users.

## API2:2023 — Broken authentication

**Addressed.**

- argon2id via `@node-rs/argon2`, not bcrypt: memory-hard, so GPU cracking is
  bounded by memory bandwidth rather than core count.
- Refresh tokens rotate on every use, and replaying a rotated token revokes the
  entire family. Reuse is checked **before** expiry
  ([`refresh-token-policy.ts`](../packages/domain/src/auth/refresh-token-policy.ts)) —
  the other order lets an attacker wait out the clock and have the replay
  written off as a benign expiry.
- The refresh token is an httpOnly cookie; the access token lives in a module
  variable, never `localStorage`. An XSS then buys the lifetime of the
  compromised page rather than a session that outlives the tab.
- Login and refresh sit in their own rate-limit bucket, an order of magnitude
  tighter than the global one.
- Login returns one message for both wrong-password and unknown-account.

**Gap:** no account lockout after repeated failures, and no MFA. Rate limiting
raises the cost of online guessing but does not stop a patient distributed
attempt. Both are real omissions for a system holding financial documents.

## API3:2023 — Broken object property level authorization

**Addressed.** Corrections are applied through an allow-list walk
([`apply-corrections.ts`](../apps/api/src/modules/review/apply-corrections.ts)):
only paths that already exist in the extraction can be written, and
`__proto__`, `constructor` and `prototype` are rejected outright. Mass
assignment is not possible because there is no assignment of a client-supplied
object — each correction is a `(path, value)` pair validated against the schema.

The corrected document is then **re-validated server-side** and rejected with a
422 if the arithmetic no longer holds. A UI that accepted a mistyped total
because nothing rendered red would silently approve a wrong invoice for payment.

Responses are assembled by explicit mappers, so a column added to the Prisma
model does not automatically appear on the wire.

## API4:2023 — Unrestricted resource consumption

**Mostly addressed.**

| Resource       | Control                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| Request volume | Per-IP throttling, two buckets, both configurable                             |
| Upload size    | Signed into the presigned PUT _and_ re-checked server-side after upload       |
| Upload content | `%PDF-` magic bytes verified by re-reading the stored object                  |
| Prompt size    | `MAX_PROMPT_TOKENS` truncation before the model sees anything                 |
| LLM calls      | Queue rate limiter, plus `MAX_EXTRACTION_ATTEMPTS` on the repair loop         |
| LLM spend      | Daily cap read from the database, so it survives a restart                    |
| Result sets    | Keyset pagination with a bounded `limit`                                      |
| Export         | Streamed as an async generator; a 50k-row export never materialises in memory |

The spend cap deserves a note: it overshoots by at most one extraction, because
the cost of a call is unknowable until it returns. Bounding it exactly would
mean predicting token counts, which is guesswork dressed as precision.

**Gap:** the cap is a single shared budget. With one tenant that is the same
thing as a per-tenant budget; the moment `tenant_id` lands it stops being, and
one noisy tenant would starve everyone else.

## API5:2023 — Broken function level authorization

**Addressed.** `JwtAuthGuard` is registered globally, so routes are private by
default and exposure requires an explicit, greppable `@Public()`. The reverse —
protection by opt-in — ships an open endpoint the first time someone forgets a
decorator.

`/metrics` is the one route with its own scheme: a shared bearer token compared
in constant time, and **404 when no token is configured**. Off by default,
because the API is the process with a public origin and a metrics endpoint that
ships open publishes request volumes, error rates and spend to anyone who
guesses the path.

**Gap:** there is a `role` column and a `@Roles()` decorator, but no route
currently uses it. Every authenticated user has identical capabilities. That is
honest for a single-tenant demo and would need real work before a second class
of user existed.

## API6:2023 — Unrestricted access to sensitive business flows

**Partially addressed.** Approval is the sensitive flow here, and it is
idempotent through the status machine: a document already `COMPLETED` cannot be
re-approved, because `COMPLETED` has no outgoing transitions. Requeue
distinguishes "never" from "not yet" and refuses to duplicate in-flight work.

**Gap:** there is no CAPTCHA or proof-of-work on registration, so automated
account creation is not prevented.

## API7:2023 — Server-side request forgery

**Addressed by construction.** The server fetches exactly two things: objects
from the configured S3 bucket, by a key it generated itself, and the Anthropic
API at a fixed base URL. No user-supplied URL is ever fetched. There is no
"import from URL" feature, which is the usual source of this class.

Presigned URLs are generated server-side and never accepted from a client.

## API8:2023 — Security misconfiguration

**Addressed.**

- Every environment variable is validated by Zod at boot; a missing or
  malformed value crashes the process immediately with an aggregated error,
  rather than surfacing at 3am on the first request that reads it.
- `JWT_SECRET` is rejected below 32 characters, so a placeholder cannot ship.
- CORS names exact origins; a wildcard is incompatible with the credentialed
  refresh cookie anyway.
- `helmet` on the API; a full CSP plus `frame-ancestors 'none'`,
  `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` on the
  web app ([`next.config.ts`](../apps/web/next.config.ts)).
- `X-Powered-By` disabled — free reconnaissance that buys nothing.
- Errors return an RFC-7807 envelope with a trace id, never a stack trace.
- Object storage blocks public access; every read is a short-lived presigned
  URL.

**Known weakness, stated plainly:** the CSP allows `'unsafe-inline'` for both
scripts and styles. Next's App Router injects inline critical CSS with no nonce
hook, and the theme script must run before first paint to avoid flashing white
at a dark-mode user. Nonces would mean rendering every page dynamically.
This meaningfully weakens the CSP as an XSS backstop — it is a real gap, not a
box ticked.

## API9:2023 — Improper inventory management

**Addressed for its size.** One version (`/api/v1`), one deployed API, no
undocumented v0 still serving traffic. `/health/live` and `/health/ready` are
intentionally public and intentionally boring — neither reveals a dependency's
address or version.

**Gap:** there is no generated OpenAPI document. The Zod contracts in
`packages/contracts` are the schema of record and are shared by the API, the
worker and the browser, so drift is prevented structurally rather than by
documentation — but a consumer outside this repository has nothing to read.

## API10:2023 — Unsafe consumption of APIs

**Addressed, and this is the interesting one.** The Anthropic API is treated as
untrusted input, not as a trusted service:

1. The reply is re-validated against the Zod schema. Never trust, always
   verify — the provider's structured-output mode is very good and still not a
   guarantee.
2. Numbers are corroborated against the source document
   ([`corroboration.ts`](../packages/domain/src/extraction/corroboration.ts)).
   A total that appears nowhere in the PDF is flagged however confident the
   model was.
3. Arithmetic is recomputed by six deterministic business rules at zero token
   cost.
4. Provider errors are classified into retriable and terminal, so a permanent
   failure does not burn a retry budget and a transient one is not treated as a
   dead document.

---

## LLM-specific risks

### Prompt injection

PDF text is attacker-controlled and **no prompt wording reliably prevents
injection.** The defence is therefore architectural rather than textual:

- The model has **no tools**. It cannot act, only describe. The worst an
  injected instruction achieves is a wrong field value.
- Output is schema-constrained and re-validated, so it cannot return a shape the
  pipeline was not expecting.
- Values are corroborated against the document, so a hallucinated or
  injection-supplied total is flagged for a human.

In other words, the blast radius of a successful injection is exactly one wrong
field on one invoice, which is the case the confidence policy and the review
queue already exist to catch.

### Extracted content is untrusted output

Vendor names, addresses and line-item descriptions come from a PDF an attacker
may have authored, and they are rendered in the browser and written to CSV.

- **XSS:** React escapes by default and there is no `dangerouslySetInnerHTML`
  anywhere in the app. The CSP is the second layer, weakened as noted above.
- **CSV injection:** a field beginning `=`, `+`, `-` or `@` is prefixed with a
  quote in [`export.service.ts`](../apps/api/src/modules/export/export.service.ts).
  Without it, an invoice with a vendor named `=cmd|...` executes when the export
  is opened in Excel — an attack on the _recipient_ of the export, who never
  saw the PDF.

---

## Supply chain

- `pnpm audit --audit-level high` gates CI. It passed on its first run because
  the seven advisories it found were **fixed** — the offending transitive
  versions are pinned in `pnpm.overrides` — rather than added to an ignore list,
  which would have made the gate decorative on day one.
- `gitleaks` scans the full history, not just the working tree. A secret
  committed three commits ago and "removed" in the fourth is still in the pack
  file and still valid.
- `pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`.
- `.env` is gitignored and has never been committed; `.env.example` ships
  placeholders only.

---

## What a real deployment would still need

Listed because a review that finds nothing has not looked:

1. **Account lockout and MFA.** Rate limiting is not sufficient on its own.
2. **A stricter CSP.** Nonce-based `script-src` and removing
   `'unsafe-inline'`, at the cost of the static shell.
3. **Row-level security.** Application-level scoping is correct today but is one
   forgotten `WHERE` from a leak. Postgres RLS makes it structural.
4. **Encryption at rest for extracted data.** Invoice contents are commercially
   sensitive and currently sit in plain columns.
5. **Audit log retention and tamper-evidence.** `document_events` is a good
   record and is as mutable as any other table.
6. **A real penetration test.** This document is the author's own reading of
   his own code, which is the least reliable kind of security review there is.
