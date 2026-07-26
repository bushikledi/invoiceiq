import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { DependencyHealthIndicator } from './dependency.health.js';
import { Public } from '../auth/auth.decorators.js';

/**
 * Liveness and readiness are genuinely different questions, and conflating them
 * causes outages: if a readiness failure restarts the process, a brief database
 * blip turns into a crash loop.
 *
 *   /health/live   is this process running?           -> restart me if not
 *   /health/ready  can it actually serve traffic?     -> route to me if so
 */
@Controller('health')
// Load balancers and container orchestrators cannot present a bearer token, so
// these must stay public. They are also exempt from rate limiting: throttling a
// readiness probe would take a healthy instance out of rotation under load,
// which is precisely backwards.
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly dependencies: DependencyHealthIndicator,
  ) {}

  /** Deliberately checks nothing external — answering at all is the signal. */
  @Get('live')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.dependencies.postgres(),
      () => this.dependencies.redisCheck(),
      () => this.dependencies.objectStorage(),
    ]);
  }
}
