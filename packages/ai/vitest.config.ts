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
        'src/index.ts',
        'src/fixtures/**',
        // Only the network wrapper is excluded, and only because covering it
        // would mean mocking the SDK to assert that we called it — a test that
        // passes whether or not the integration works. Its one piece of real
        // logic, the retriable/terminal split, lives in error-classification.ts
        // and IS covered. The wrapper itself is exercised by the nightly
        // contract job against the live API.
        'src/adapters/anthropic-extractor.ts',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
