# 9. Local multilingual embeddings by default

**Status:** accepted

## Context

Semantic search needs an embedding model. The sample invoices are Italian and
English. This project was built with no API key available.

## Decision

An `EmbeddingProvider` port with three adapters. Default to a local multilingual
MiniLM (384 dimensions) running in-process.

| Adapter         | Dimensions | Trade                                                   |
| --------------- | ---------- | ------------------------------------------------------- |
| `local`         | 384        | No key, real semantics, ~120 MB model, CPU per document |
| `openai`        | 1536       | Better quality, needs a key, needs a migration          |
| `deterministic` | any        | Not semantic — stable, instant, for tests               |

## Consequences

Search is demonstrable with no key at all, which matters because "the most
interesting feature is dark until you add a credit card" is a bad answer.

`EMBEDDING_*` lives in the **shared** env schema, not the worker's. The worker
embeds documents and the API embeds queries; different models put the query in a
different vector space and every result becomes noise, with no error anywhere.
Sharing the definition makes that agreement structural.

Dimensionality is part of the port contract and asserted at boot, because the
column is a fixed `vector(384)`. Switching to OpenAI is a migration, not a
config change, and the adapter says so before serving traffic rather than
failing on the first insert.

**The honest limitation:** cross-language retrieval is this model's weak spot.
Bare "chairs" does reach the Italian _Sedie ufficio_ invoices; "chairs from the
Milan vendor" does not rank them first. The UI suggests queries verified to rank
correctly rather than ones that merely read well.

## Alternatives

**OpenAI only.** Better quality, one adapter. Rejected: search would be dead
until a key exists.

**Deterministic only.** Zero dependencies. Rejected: the pipeline would look
complete while search returned near-random results.
