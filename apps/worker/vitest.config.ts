import { defineConfig } from 'vitest/config';

/** Unit tests only — see the note in apps/api/vitest.config.ts. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
