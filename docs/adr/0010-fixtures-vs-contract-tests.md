# 10. Recorded fixtures on PRs, real API nightly

**Status:** accepted

## Context

The pipeline depends on a paid, non-deterministic, remote service. CI must be
fast, free and repeatable; provider drift must still be caught.

## Decision

Split by purpose. PRs run the real worker against recorded model output. A
nightly job runs the sample PDFs against the live API.

## Consequences

Every PR exercises the genuine pipeline — BullMQ delivery, Prisma transactions,
PDF parsing, validation, persistence — with only the network call replaced. Not
because it is inconvenient, but because it costs money and returns something
different every time.

Fixtures are **recordings, not mocks**. A mock encodes what we think the model
does and stays wrong forever; a recording is what it actually did, and
refreshing it makes drift visible as a diff.

Two properties keep them honest:

- Each fixture is asserted against the **sample PDF it describes**. A scenario
  named `sum-mismatch` whose numbers happen to add up fails the build. This
  caught a real bug — a fixture carrying dates absent from its own PDF, which
  made the review screen flag correct fields.
- The `FixtureLlmExtractor` is stateless. The worker holds one instance and
  processes documents concurrently, so per-extraction state on it would be a
  data race producing extractions that parse, validate and score perfectly while
  belonging to the wrong invoice.

The nightly job is where "did the provider change under us?" gets answered, on a
schedule, rather than during a demo.

## Alternatives

**Hit the real API in CI.** Maximum fidelity. Rejected: slow, costs money per
PR, and flaky in a way that trains people to re-run red builds.

**Mock everything.** Free and fast. Rejected: proves only that the code calls
the function it calls.
