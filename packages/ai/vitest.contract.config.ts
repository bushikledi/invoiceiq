import { defineConfig } from 'vitest/config';

/**
 * The live-provider suite, deliberately separate from vitest.config.ts.
 *
 * The unit config globs every `.test.ts` file under src, and a live test living
 * inside that glob is one `describe.skip` away from silently billing every
 * contributor who happens to have ANTHROPIC_API_KEY exported. A different
 * filename and a different config make "does this cost money?" answerable from
 * the command being run, rather than from reading the test body.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.contract.ts'],
    environment: 'node',
    // One live call at a time: the provider rate-limits, and three parallel
    // files racing a 429 would report a provider outage as a contract break.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
