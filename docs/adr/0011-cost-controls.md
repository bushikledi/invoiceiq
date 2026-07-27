# 11. Three cost controls, aimed at three different failures

**Status:** accepted

## Context

The LLM is the only line item that scales with usage, and there are three
separate ways it runs away: paying twice for identical input, paying premium
rates for input that does not need them, and a loop billing all night unattended.

A single control cannot address all three, because they fail on different time
scales — the first is per-document, the second per-attempt, the third per-day.

## Decision

**Cache** on `(content_sha256, prompt_version, model)`. All three parts, because
changing any one changes the answer: the hash is the document, the prompt version
is the question, the model is the answerer.

Only the **model output** is cached. Validation, confidence scoring and chunking
re-run on every hit.

**Tier** the model: two attempts on a Haiku-class model, then escalate to a
Sonnet-class one. The trigger is a **schema failure**, never low confidence.

**Cap** daily spend, read from the database rather than from memory, checked
before the call.

## Consequences

Caching only the output is the load-bearing choice. Those downstream steps are
pure, deterministic and free, and they are also the steps most likely to have
changed since the cached row was written — so caching the _verdict_ would mean a
tightened business rule silently did not apply to duplicate uploads. A cache that
hides a bug fix is worse than no cache. As a bonus, a hit exercises exactly the
same downstream code a miss does, so the cached path cannot rot.

Escalating on schema failure and not on confidence is the difference between a
retry with a reason to succeed and one without. A stronger model can plausibly
produce well-formed output where a weaker one could not. It will just as
confidently agree with a doubtful number — so paying twice to learn nothing is
the wrong move, and that case belongs to a human. That is what the review queue
is for.

The cap is checked before the call and therefore **overshoots by at most one
extraction**, because the cost of a call is unknowable until it returns.
Bounding it exactly would mean predicting token counts, which is guesswork
dressed as precision. It is also non-retriable: re-checking the same budget
after a backoff burns the job's attempts to arrive at the same answer.

Reading spend from the database rather than an in-memory counter means the
budget survives a restart — which matters most at exactly the moment a runaway
loop is likely to be redeployed alongside its own fix.

## What this cost us

The cache lookup keys on the extractor's **own reported identity**, not on
`LLM_MODEL`. That distinction is not cosmetic: under the fixture provider,
configuration says `claude-haiku-…` while every stored row says
`fixture-model`, so a configuration-keyed cache never matches. It would have
been dead in precisely the configuration the entire test suite runs in, and
silently — a cache that always misses is indistinguishable from one that is
working and simply has nothing to reuse.

That is why `LlmExtractor` now carries a `modelId`: the port has to answer "who
would answer this?" and only the adapter knows.

The cap is a single shared budget. With one tenant that is the same thing as a
per-tenant budget. It stops being the same thing the moment `tenant_id` lands,
and at that point one noisy tenant would starve everyone else.

## Alternatives

**A TTL cache in Redis.** Faster to read and wrong in kind: the correctness
condition here is content identity, not recency. A cached extraction of
unchanged bytes under an unchanged prompt does not become less correct with age,
and a TTL would throw away valid work on a schedule unrelated to anything.

**Always use the strong model.** Simpler, and roughly five times the price for
the majority of invoices that are a table of numbers the cheap model reads
correctly.

**Rely only on the provider's spend cap.** It should also be set, and it
protects the bill some hours later by disabling the key for everything —
including the parts still working. This one fails the affected documents with a
reason a human can read and leaves search, review and export running.
