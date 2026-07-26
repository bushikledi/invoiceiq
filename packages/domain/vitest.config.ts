import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // The domain layer is the one place where near-total coverage is the
      // right target: it is pure, fast, and everything else trusts it.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
