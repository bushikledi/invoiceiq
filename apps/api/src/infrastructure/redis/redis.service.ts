import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';

/**
 * Shared Redis connection for the API.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ (M7) and harmless here;
 * setting it consistently avoids two connections with divergent retry
 * behaviour against the same server.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      // Fail a readiness probe quickly rather than hanging it for 30 seconds.
      connectTimeout: 5_000,
      lazyConnect: false,
    });

    // Without a listener, a connection error is an unhandled 'error' event and
    // takes the process down.
    this.client.on('error', () => {
      /* surfaced by the readiness check; deliberately not fatal */
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<void> {
    // ioredis types this as the literal 'PONG', which would make the guard
    // below provably dead code. Widening to string keeps the runtime check
    // meaningful — a proxy, a cluster redirect, or a protocol-level oddity can
    // return something else, and a readiness probe should notice.
    const reply: string = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error(`Unexpected PING reply: ${reply}`);
    }
  }
}
