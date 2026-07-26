import { defineConfig } from 'vitest/config';

/**
 * Integration suite: real Postgres + Redis + MinIO via Testcontainers, with the
 * LLM behind FixtureLlmExtractor so the whole pipeline runs with zero network
 * and zero spend.
 *
 * Separate from the unit config because these tests are slow, need Docker, and
 * must never run concurrently against a shared database.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    environment: 'node',
    // Containers take a while to become healthy on a cold CI runner.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // One database, one migration state: parallel files would race.
    fileParallelism: false,
    pool: 'forks',
  },
});
