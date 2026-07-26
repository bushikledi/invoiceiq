import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import type { WorkerEnv } from '@invoiceiq/config';
import { WorkerConfigModule, WORKER_ENV } from './config/config.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { LlmModule } from './ai/llm.module.js';
import { ExtractDocumentProcessor } from './pipeline/extract-document.processor.js';
import { QUEUE_EMBEDDING, QUEUE_EXTRACTION } from './queues.js';
import { HeartbeatService } from './health/heartbeat.service.js';

@Module({
  imports: [
    WorkerConfigModule,

    LoggerModule.forRootAsync({
      inject: [WORKER_ENV],
      useFactory: (env: WorkerEnv) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          transport:
            env.NODE_ENV === 'development'
              ? {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'HH:MM:ss.l' },
                }
              : undefined,
          // No HTTP surface here; request autologging would only emit noise.
          autoLogging: false,
        },
      }),
    }),

    BullModule.forRootAsync({
      inject: [WORKER_ENV],
      useFactory: (env: WorkerEnv) => ({
        connection: {
          url: env.REDIS_URL,
          // BullMQ blocks on BRPOPLPUSH; a retry ceiling would abort those reads.
          maxRetriesPerRequest: null,
        },
      }),
    }),

    BullModule.registerQueueAsync(
      {
        name: QUEUE_EXTRACTION,
        inject: [WORKER_ENV],
        useFactory: (env: WorkerEnv) => ({
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: 3_600, count: 1_000 },
            // Failures survive a week so a post-mortem has something to read.
            removeOnFail: { age: 7 * 24 * 3_600 },
          },
          limiter: {
            // A blunt ceiling on spend, independent of provider rate limits.
            max: env.EXTRACTION_RATE_LIMIT_PER_MINUTE,
            duration: 60_000,
          },
        }),
      },
      {
        name: QUEUE_EMBEDDING,
        useFactory: () => ({
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 2_000 },
            removeOnComplete: { age: 3_600, count: 1_000 },
            removeOnFail: { age: 7 * 24 * 3_600 },
          },
        }),
      },
    ),

    PrismaModule,
    StorageModule,
    LlmModule,
  ],
  providers: [ExtractDocumentProcessor, HeartbeatService],
})
export class WorkerAppModule {}
