import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../config/config.module.js';

/** Key the API's readiness check reads to tell whether any worker is alive. */
export const WORKER_HEARTBEAT_KEY = 'invoiceiq:worker:heartbeat';

const INTERVAL_MS = 10_000;
/** Expiry comfortably exceeds the interval so a slow tick is not a false alarm. */
const TTL_SECONDS = 30;

/**
 * The worker has no HTTP port, so it cannot expose a readiness endpoint of its
 * own. Instead it writes a TTL'd key to Redis; if the key disappears, every
 * worker is gone and the API can report that in its own health output.
 */
@Injectable()
export class HeartbeatService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly redis: Redis;
  private timer?: NodeJS.Timeout;

  constructor(@Inject(WORKER_ENV) private readonly env: WorkerEnv) {
    this.redis = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.redis.on('error', () => {
      /* the missing heartbeat is itself the signal */
    });
  }

  async onModuleInit(): Promise<void> {
    await this.beat();

    this.timer = setInterval(() => {
      void this.beat();
    }, INTERVAL_MS);

    // Do not hold the event loop open purely to keep beating.
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);

    // Remove the key on a clean exit so the API reports "no workers"
    // immediately rather than waiting out the TTL.
    try {
      await this.redis.del(WORKER_HEARTBEAT_KEY);
    } catch {
      /* shutting down anyway */
    }
    await this.redis.quit();
  }

  private async beat(): Promise<void> {
    try {
      await this.redis.set(
        WORKER_HEARTBEAT_KEY,
        // An operator-facing wall-clock timestamp, not a business rule.
        // Liveness is carried by the key's TTL; this value exists only so a
        // human reading the key can see how fresh it is, so injecting a Clock
        // would buy nothing.
        // eslint-disable-next-line no-restricted-syntax
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        'EX',
        TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(`Heartbeat write failed: ${String(error)}`);
    }
  }
}
