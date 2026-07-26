import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUE_EXTRACTION } from '../queues.js';

/**
 * Walking-skeleton consumer.
 *
 * It exists to prove the whole spine end to end at M2 — Redis connection,
 * BullMQ registration, concurrency, graceful drain — before any extraction
 * logic depends on it. M7 replaces the body with the real pipeline; the
 * surrounding wiring is already proven by then.
 */
@Processor(QUEUE_EXTRACTION, { concurrency: 2 })
export class NoopProcessor extends WorkerHost {
  private readonly logger = new Logger(NoopProcessor.name);

  async process(job: Job<{ traceId?: string }>): Promise<{ acknowledged: true }> {
    this.logger.log(
      `Processing ${job.name} id=${job.id} attempt=${job.attemptsMade + 1} trace=${job.data.traceId ?? 'none'}`,
    );

    // Stands in for the LLM call so the graceful-shutdown path has something
    // in flight to wait on.
    await new Promise((resolve) => setTimeout(resolve, 50));

    return { acknowledged: true };
  }
}
