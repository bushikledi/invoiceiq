# 7. Composite confidence, combined with min()

**Status:** accepted

## Context

Something must decide which extractions a human looks at. Reviewing everything
defeats the point; reviewing nothing means paying wrong invoices.

## Decision

Score each field from three independent signals and take the **minimum**:

```
fieldScore = min(selfReport, presence, corroboration)
flagged    = fieldScore < 0.85
overall    = weighted mean, totals and VAT counted twice
```

- **selfReport** — the model's own confidence for that field.
- **presence** — 0.4 when an expected field came back null.
- **corroboration** — 0.5 when the value appears nowhere in the PDF text.

## Consequences

`min()` rather than an average is the whole decision. Each signal can
independently condemn a field: a total the model reports at 0.99 confidence that
appears nowhere in the document is not 65% trustworthy, it is wrong. Averaging
launders precisely the failure that matters most.

Corroboration is the cheap differentiator — zero extra tokens, no latency, and
it catches hallucinated numbers deterministically. It required real work to be
useful: invoices print `€1.240,50`, `1 240,50` and `1,240.50` for the same
amount, so every number in the source is tokenised into minor units once and
compared as an integer.

When there is no source text, corroboration is skipped rather than scored as
failure. Otherwise every field of every scanned document would be flagged for a
reason that says nothing about the extraction.

Each flagged field carries _why_ it was flagged. "Does not appear in the
document" and "the model reported low confidence" send a reviewer to different
places, and collapsing them into a generic warning wastes the whole policy.

## Alternatives

**Trust the model's self-reported confidence.** One number, no code. Rejected:
self-reported confidence is poorly calibrated exactly where it matters, and a
confident hallucination is the failure mode this system exists to prevent.
