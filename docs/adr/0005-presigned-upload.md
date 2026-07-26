# 5. Presigned direct-to-storage upload

**Status:** accepted

## Context

Invoice PDFs are up to 10 MB. The API runs in 512 MB containers behind a proxy
with a 30-second request timeout.

## Decision

The browser uploads directly to S3 using a presigned PUT. The API issues the
signature and, in a separate call, verifies the result.

```
POST /documents/uploads   → presigned PUT + document row (UPLOADED)
PUT  <presigned url>      → bytes go browser → storage; the API never sees them
POST /documents/:id/complete → server HEADs the object, checks size and
                               magic bytes, hashes it, transitions to QUEUED
```

## Consequences

Large bodies never occupy API memory, and a slow client cannot hold a request
open until the proxy kills it.

The cost is that `/complete` is a genuine trust boundary rather than a
formality. A presigned URL can be used to store anything within the signed
constraints, so the server re-reads the object: it checks the declared size
against the actual one and reads the first five bytes for `%PDF-`. Content-Type
is client-supplied metadata and proves nothing. An integration test uploads an
`MZ` executable named `invoice.pdf` with `Content-Type: application/pdf`; the
presign succeeds, the PUT succeeds, and completion rejects it on the bytes.

Storage keys are server-generated UUIDs. A key built from the client's filename
would accept `../../etc/passwd.pdf`.

## Alternatives

**Proxy the bytes through the API.** Simpler by one round trip, and one
`/upload` endpoint instead of three. Rejected on memory and timeout grounds, and
because the trust boundary would still need to exist — the bytes would just
arrive somewhere more expensive.
