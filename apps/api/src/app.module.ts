import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { loadApiEnv } from '@invoiceiq/config';
import { ApiConfigModule } from './config/config.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { TraceMiddleware } from './common/trace/trace.middleware.js';
import { buildLoggerConfig } from './logging/logger.config.js';

// Parsed here rather than injected because LoggerModule.forRoot needs the
// values before the DI container exists. loadApiEnv is pure and memoised by
// module caching, so this is not a second source of truth.
const env = loadApiEnv(process.env);

@Module({
  imports: [
    ApiConfigModule,
    LoggerModule.forRoot(buildLoggerConfig(env)),

    // A blunt global ceiling. Auth routes get a far tighter limit of their own
    // in M3 — brute-forcing a login is the attack that matters.
    ThrottlerModule.forRoot([{ name: 'global', ttl: 60_000, limit: 100 }]),

    PrismaModule,
    RedisModule,
    StorageModule,

    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must run before everything else so the trace id exists for the very first
    // log line of the request.
    consumer.apply(TraceMiddleware).forRoutes('*path');
  }
}
