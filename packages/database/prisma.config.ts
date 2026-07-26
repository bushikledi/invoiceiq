import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Replaces the deprecated `package.json#prisma` key, which Prisma 7 removes.
 *
 * Note: declaring this file disables Prisma's implicit .env loading, which is
 * why every db:* script already pipes through `dotenv -e ../../.env`. The
 * monorepo keeps one .env at the root rather than a copy per package.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
