import { PrismaClient } from '../generated/client/index.js';

export type { PrismaClient };

export interface PrismaClientOptions {
  databaseUrl: string;
  /** Emit every query at debug level. Noisy — development only. */
  logQueries?: boolean;
}

/**
 * Creates a client. Callers own the lifecycle: Nest binds it to a provider with
 * `onModuleDestroy`, scripts call `$disconnect` themselves.
 *
 * There is no module-level singleton on purpose. A hidden global connection
 * pool is the reason integration tests leak handles between suites and refuse
 * to exit.
 */
export function createPrismaClient({
  databaseUrl,
  logQueries = false,
}: PrismaClientOptions): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  });
}
