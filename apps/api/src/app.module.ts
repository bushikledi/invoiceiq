import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { ApiEnv } from '@invoiceiq/config';
import { ApiConfigModule, API_ENV } from './config/config.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { ReviewModule } from './modules/review/review.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { ExportModule } from './modules/export/export.module.js';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { TraceMiddleware } from './common/trace/trace.middleware.js';
import { buildLoggerConfig } from './logging/logger.config.js';
import { HttpMetricsInterceptor, MetricsModule } from './modules/metrics/metrics.module.js';

/**
 * Every module that needs configuration resolves it through DI, never at import
 * time. Parsing process.env in module scope would mean the mere act of
 * importing AppModule requires a fully-populated environment — which breaks
 * integration tests (containers assign their ports *after* import) and makes
 * failures depend on module evaluation order.
 */
@Module({
  imports: [
    ApiConfigModule,

    LoggerModule.forRootAsync({
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => buildLoggerConfig(env),
    }),

    // Two named buckets: a blunt global ceiling, and a much tighter one the
    // auth controller opts into via @Throttle({ auth: ... }) — login and
    // refresh are the routes actually worth brute-forcing.
    ThrottlerModule.forRoot([
      { name: 'global', ttl: 60_000, limit: 100 },
      { name: 'auth', ttl: 60_000, limit: 10 },
    ]),

    PrismaModule,
    RedisModule,
    StorageModule,

    HealthModule,
    MetricsModule,
    AuthModule,
    DocumentsModule,
    ReviewModule,
    SearchModule,
    ExportModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Outermost interceptor, so the latency it records is what the client
    // experienced — including time spent in guards and in the exception filter.
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Registered globally so every route is authenticated unless it opts out
    // with @Public(). Protection by default; exposure is the explicit act.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must run before everything else so the trace id exists for the very first
    // log line of the request.
    consumer.apply(TraceMiddleware).forRoutes('*path');
  }
}
