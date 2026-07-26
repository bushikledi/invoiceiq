import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@invoiceiq/database';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../../config/config.module.js';

/** Owns the worker's Prisma connection lifecycle. */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(WORKER_ENV) env: WorkerEnv) {
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
}
