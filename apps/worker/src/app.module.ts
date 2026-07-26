import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import { loadWorkerEnv } from '@invoiceiq/config';
import { WorkerConfigModule } from './config/config.module.js';
import { NoopProcessor } from './processors/noop.processor.js';
import { QUEUE_EMBEDDING, QUEUE_EXTRACTION } from './queues.js';
import { HeartbeatService } from './health/heartbeat.service.js';

const env = loadWorkerEnv(process.env);

@Module({
  imports: [
    WorkerConfigModule,

    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        transport:
          env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss.l' } }
            : undefined,
        // The worker serves no HTTP traffic; request autologging would only
        // emit noise.
        autoLogging: false,
      },
    }),

    BullModule.forRoot({
      connection: {
        url: env.REDIS_URL,
        // BullMQ blocks on BRPOPLPUSH; a retry ceiling would abort those reads.
        maxRetriesPerRequest: null,
      },
    }),

    BullModule.registerQueue(
      {
        name: QUEUE_EXTRACTION,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          // Keep failures around for post-mortems, but bounded.
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      },
      {
        name: QUEUE_EMBEDDING,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 3_600, count: 1_000 },
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      },
    ),
  ],
  providers: [NoopProcessor, HeartbeatService],
})
export class WorkerAppModule {}
