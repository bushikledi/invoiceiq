import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';
import { StorageService } from '../../infrastructure/storage/storage.service.js';

/** Readiness probes must never hang a load balancer; each gets a hard ceiling. */
const PROBE_TIMEOUT_MS = 3_000;

async function withTimeout(label: string, probe: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([probe(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Readiness indicators for the three things the API cannot serve without.
 *
 * Each reports independently so a failing probe names the culprit — "redis is
 * down" beats "readiness failed" at 3am.
 */
@Injectable()
export class DependencyHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  postgres(): Promise<HealthIndicatorResult> {
    return this.probe('postgres', () => this.prisma.ping());
  }

  redisCheck(): Promise<HealthIndicatorResult> {
    return this.probe('redis', () => this.redis.ping());
  }

  objectStorage(): Promise<HealthIndicatorResult> {
    return this.probe('storage', () => this.storage.ping());
  }

  private async probe(key: string, fn: () => Promise<void>): Promise<HealthIndicatorResult> {
    const indicator = this.health.check(key);
    const startedAt = Date.now();

    try {
      await withTimeout(key, fn);
      return indicator.up({ latencyMs: Date.now() - startedAt });
    } catch (error) {
      return indicator.down({
        latencyMs: Date.now() - startedAt,
        // The reason is safe to expose: readiness endpoints are operational,
        // and a bare "down" costs real debugging time.
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
}
