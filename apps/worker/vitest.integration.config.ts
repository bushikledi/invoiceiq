import { defineConfig } from 'vitest/config';

/**
 * Pipeline integration suite: the real worker against real Postgres, Redis and
 * MinIO, with only the LLM replaced by recorded fixtures.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 240_000,
    // One database, one queue: parallel files would race each other.
    fileParallelism: false,
    pool: 'forks',
  },
});
