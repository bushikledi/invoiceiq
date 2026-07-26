import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@invoiceiq/database';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';

/**
 * Owns the Prisma connection lifecycle.
 *
 * Nest calls `onModuleDestroy` during graceful shutdown, so `$disconnect` runs
 * before the process exits and connections are not left dangling on the
 * database — which is what exhausts the pool during a rolling deploy.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = createPrismaClient({
      databaseUrl: env.DATABASE_URL,
      logQueries: env.NODE_ENV === 'development',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /** Cheapest possible liveness probe for the readiness check. */
  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }
}
