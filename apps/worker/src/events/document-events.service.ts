import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { DOCUMENT_EVENTS_CHANNEL, type DocumentEventMessage } from '@invoiceiq/contracts';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../config/config.module.js';

/**
 * Announces status changes so the dashboard can stop polling.
 *
 * ## Fire-and-forget, deliberately
 *
 * Redis pub/sub has no delivery guarantee: a subscriber that is disconnected
 * during a publish never learns the message existed. That is not a defect to be
 * worked around here — it is the reason the client keeps a polling fallback.
 * The database remains the single source of truth; this channel is an
 * *optimisation* that makes the UI feel instant, and treating it as anything
 * more would put correctness on top of a transport that cannot carry it.
 *
 * Which is why publishing failures are logged and swallowed. A document whose
 * status changed correctly but whose announcement was lost is a document the
 * user sees one poll interval later. A document whose transaction was rolled
 * back because Redis hiccuped is a lost extraction.
 *
 * ## A separate connection
 *
 * BullMQ's connection is not reused. ioredis puts a connection into subscriber
 * mode on the first SUBSCRIBE, after which it refuses ordinary commands — and
 * while only the API subscribes today, sharing the queue's connection would
 * make that a latent trap for whoever adds a subscriber to the worker next.
 */
@Injectable()
export class DocumentEventsPublisher implements OnApplicationShutdown {
  private readonly logger = new Logger(DocumentEventsPublisher.name);
  private readonly redis: Redis;

  constructor(@Inject(WORKER_ENV) env: WorkerEnv) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    this.redis.on('error', () => {
      /* Publishing is best-effort; a connection error must not be fatal. */
    });
  }

  /**
   * Publishes a status change.
   *
   * Call this *after* the transaction commits. Publishing from inside one
   * announces a state that may still be rolled back, and a client that acted on
   * it would render a document as COMPLETED that the database never agreed was
   * completed.
   */
  async publish(event: DocumentEventMessage): Promise<void> {
    try {
      await this.redis.publish(DOCUMENT_EVENTS_CHANNEL, JSON.stringify(event));
    } catch (error) {
      this.logger.warn(`Could not publish ${event.documentId} → ${event.status}: ${String(error)}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
