import { Global, Module } from '@nestjs/common';
import { loadWorkerEnv, type WorkerEnv } from '@invoiceiq/config';

export const WORKER_ENV = Symbol('WORKER_ENV');

/**
 * The worker validates a different slice of the environment than the API: it
 * needs LLM and embedding credentials but no JWT secret. Splitting the schemas
 * means a missing key fails the process that actually needs it.
 */
@Global()
@Module({
  providers: [
    {
      provide: WORKER_ENV,
      useFactory: (): WorkerEnv => loadWorkerEnv(process.env),
    },
  ],
  exports: [WORKER_ENV],
})
export class WorkerConfigModule {}
