# 4. Zod as the only schema language

**Status:** Accepted · **Date:** 2026-07-26

## Context

This system validates in four distinct places: environment variables at boot,
HTTP request bodies, the LLM's structured output, and the frontend's view of
API responses. The default NestJS answer is class-validator with decorated DTO
classes.

The LLM boundary is what breaks that default. We must hand the provider a JSON
Schema describing the invoice shape, and then re-validate whatever comes back.
If the JSON Schema and the validator are separate artifacts, they drift — and
the failure mode is a model that confidently returns a field the parser then
rejects, burning a retry every time.

## Decision

Zod 4 everywhere. One schema per concept, and the JSON Schema handed to the
provider is *generated from it* via Zod 4's built-in `z.toJSONSchema()`, so
generation and validation cannot disagree.

- `packages/config` — environment, validated once at boot.
- `packages/domain` — the invoice extraction schema.
- `packages/contracts` — request/response DTOs, shared with the browser.
- `apps/api` — `nestjs-zod` pipes the contract schemas as DTOs.

## Consequences

**Good.** The extraction schema exists once. Frontend types come from
`z.infer<>` with no codegen step. A single `ZodError` shape means the exception
filter has one validation branch, not several.

**Bad.** Diverges from mainstream NestJS examples, so a new contributor
familiar with class-validator has something to learn. Zod schemas also carry a
runtime cost that decorators partly avoid — irrelevant at this request volume.

## Notes

- `zod-to-json-schema` is not used: Zod 4 has native `z.toJSONSchema()`, and
  the extra dependency would be one more thing that can drift.
- `nestjs-zod@5.5` accepts `zod ^4`, verified before committing to this. Had it
  not, the fallback was a ~30-line `ZodValidationPipe` — the decision here is
  "one schema language", not "this specific package".
- Structured-output mode is the first defence and the Zod re-parse is the
  second. Provider strict mode enforces shape but knows nothing about
  cross-field semantics like "line items must sum to the subtotal".

## Alternatives

- **class-validator + class-transformer.** The Nest default. Rejected: it
  cannot describe the LLM output schema, so the project would need Zod anyway,
  and then have two validation systems.
- **TypeBox / Valibot.** Both fine; Zod has the better ecosystem here,
  including the `nestjs-zod` integration.
