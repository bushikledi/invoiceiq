# 1. pnpm workspaces + Turborepo monorepo

**Status:** Accepted · **Date:** 2026-07-26

## Context

The extraction schema is the single most duplicated concept in a system like
this. It is needed by the worker (to constrain and validate the LLM output), by
the API (to type request and response bodies), and by the frontend (to render
and edit the extracted fields). Three copies of that schema in three repos
drift within weeks, and the drift is silent until a field renders blank.

## Decision

One repository, pnpm workspaces for linking, Turborepo for task orchestration.
`apps/{api,worker,web}` are deployables; `packages/{domain,contracts,ai,database,config}`
are libraries.

## Consequences

**Good.** The Zod schema is authored once in `packages/domain` and consumed
everywhere by import, so drift is a type error rather than a bug. One CI
pipeline. One `pnpm bootstrap` for a new contributor. Turbo's `dependsOn:
["^build"]` gives correct topological builds for free.

**Bad.** Every CI job installs the whole workspace. Turbo's cache mitigates
this, but a genuinely large repo would need remote caching.

**Sharp edge, learned the hard way.** A bare `pnpm --filter <app> build` does
_not_ build that app's workspace dependencies — only `turbo run build --filter`
respects the task graph. The Dockerfile initially used the former and failed on
`Cannot find module '@invoiceiq/config'`.

## Alternatives

- **Polyrepo.** Rejected: the shared-schema problem above is the whole point.
- **npm/yarn workspaces.** pnpm's strict linking is a feature here — it makes
  undeclared transitive dependencies fail loudly instead of resolving by luck.
