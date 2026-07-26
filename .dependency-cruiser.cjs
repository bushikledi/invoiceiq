/**
 * Architectural boundaries, enforced.
 *
 * This file is the difference between "we intend clean architecture" and
 * "we have it". The dependency rule (arrows point inward only) is checked in
 * CI, so a violation fails the build rather than surviving code review.
 *
 * Run: pnpm boundaries        Graph: pnpm boundaries:graph
 */

/** pnpm resolves through a content-addressed store, so a package's real path
 * looks like `node_modules/.pnpm/zod@4.4.3/node_modules/zod/…`. Matching on the
 * trailing `/<name>/` segment is precise: `/zod/` does not match `/nestjs-zod/`
 * or `/zod-to-json-schema/`. */
const pkg = (name) => `/${name}/`;

module.exports = {
  forbidden: [
    {
      name: 'domain-is-framework-free',
      comment:
        'packages/domain is the heart of the system: pure TypeScript, zero framework imports, ' +
        '100% unit-testable. It may depend on zod and nothing else. If you need Nest, Prisma, ' +
        'BullMQ or an AI SDK here, you are writing infrastructure — move it outward.',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg'],
        pathNot: [pkg('zod')],
      },
    },
    {
      name: 'domain-imports-no-workspace-packages',
      comment: 'domain sits at the centre — it cannot depend on contracts, database, ai or config.',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: { path: '^packages/(?!domain/)' },
    },
    {
      name: 'web-talks-through-contracts-only',
      comment:
        'apps/web may import types from packages/contracts. Reaching into database or ai would ' +
        'leak Prisma entities and provider SDKs into the browser bundle.',
      severity: 'error',
      from: { path: '^apps/web' },
      to: { path: '^packages/(database|ai)/' },
    },
    {
      name: 'contracts-stay-transport-only',
      comment: 'packages/contracts describes the wire format; it must not depend on persistence.',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { path: '^packages/(database|ai)/' },
    },
    {
      name: 'packages-never-import-apps',
      comment: 'Dependencies point from apps into packages, never the reverse.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-are-independent',
      comment: 'api, worker and web share code through packages/, not through each other.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/([^/]+)/', pathNot: '^apps/$1/' },
    },
    {
      name: 'no-circular',
      comment: 'A dependency cycle is a design smell and breaks incremental builds.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-dev-deps-in-src',
      comment: 'Production source must not import a devDependency — it will be absent at runtime.',
      severity: 'error',
      from: { path: '^(apps|packages)/[^/]+/src', pathNot: '\\.(test|spec)\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-unresolvable',
      comment:
        'An import that does not resolve is either a typo or a package that was never installed. ' +
        'This rule matters for the boundary checks above: an uninstalled framework import ' +
        '(e.g. @nestjs/common inside packages/domain) produces no npm dependency edge, so the ' +
        'purity rules would silently miss it. Catch it here instead.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys|querystring)$' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(dist|\\.next|\\.turbo|coverage|generated|node_modules/\\.bin)(/|$)',
    },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)' },
      archi: {
        collapsePattern: '^(apps|packages)/[^/]+/src/[^/]+',
      },
    },
  },
};
