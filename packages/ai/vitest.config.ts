import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // The live-provider suite is a test, and it self-skips without an API
        // key — so under coverage it is 100 lines that never execute, dragging
        // the package below its threshold and reporting it as a coverage
        // regression in code that had not changed. It is excluded for the same
        // reason *.test.ts is: measuring a test's coverage is a category error.
        'src/**/*.contract.ts',
        'src/index.ts',
        'src/fixtures/**',
        // Only the network wrapper is excluded, and only because covering it
        // would mean mocking the SDK to assert that we called it — a test that
        // passes whether or not the integration works. Its one piece of real
        // logic, the retriable/terminal split, lives in error-classification.ts
        // and IS covered. The wrapper itself is exercised by the nightly
        // contract job against the live API.
        'src/adapters/anthropic-extractor.ts',
        // Same rationale as the extractor above: these two are thin wrappers
        // around a network call and a 120 MB model download. Covering them
        // means mocking the transport to assert that we called it. The
        // deterministic embedder — the one with real logic in it — IS covered.
        'src/adapters/local-embedder.ts',
        'src/adapters/openai-embedder.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
