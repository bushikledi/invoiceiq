import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — anything colocated with the source under src/.
 *
 * Without this file vitest falls back to its default glob, which happily picks
 * up test/*.integration.test.ts and quietly runs the entire Testcontainers
 * suite under the name "unit tests": Docker required, minutes instead of
 * milliseconds, and the same work the integration job already does.
 *
 * The integration suite has its own config (vitest.integration.config.ts) and
 * its own CI job.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
