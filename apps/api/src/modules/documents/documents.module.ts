import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { StatsService } from './stats.service.js';
import { QUEUE_EXTRACTION } from './queue.constants.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => ({
        connection: {
          url: env.REDIS_URL,
          // BullMQ's blocking reads must not be aborted by a retry ceiling.
          maxRetriesPerRequest: null,
        },
      }),
    }),
    // The API is a producer only. The worker owns consumption; registering the
    // queue here just gives us something to `add()` to.
    BullModule.registerQueue({
      name: QUEUE_EXTRACTION,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        // Failures survive a week so a post-mortem has something to read.
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    }),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, StatsService],
  exports: [DocumentsService, StatsService],
})
export class DocumentsModule {}
