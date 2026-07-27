import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Global,
  Headers,
  Injectable,
  Module,
  NestInterceptor,
  NotFoundException,
  Inject,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import type { Response } from 'express';
import { createMetrics, type Metrics } from '@invoiceiq/observability';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';
import { Public } from '../auth/auth.decorators.js';

@Injectable()
export class ApiMetrics {
  readonly metrics: Metrics = createMetrics();
}

/**
 * Records request latency, labelled by route *pattern*.
 *
 * The pattern (`/documents/:id`) rather than the resolved path
 * (`/documents/3f2a…`) is the entire point. Prometheus creates one time series
 * per distinct label combination, so labelling by resolved path would create a
 * series per document — an unbounded cardinality explosion that takes down the
 * metrics backend, caused by the monitoring rather than by anything being
 * monitored. Express exposes the pattern on `route.path`; anything without one
 * (a 404) is bucketed as `unmatched` rather than by its arbitrary URL.
 */
interface RoutedRequest {
  readonly method: string;
  /** Present once Express has matched a route; absent on a 404. */
  readonly route?: { readonly path?: string };
}

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: ApiMetrics) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    // A narrow local shape rather than Express's `Request`, whose `route` is
    // typed `any` — intersecting with it would make `route.path` an unchecked
    // `any` read. Declaring only the two fields actually used keeps the access
    // type-checked and states the dependency exactly.
    const request = http.getRequest<RoutedRequest>();
    const response = http.getResponse<Response>();
    const started = process.hrtime.bigint();

    const record = () => {
      this.metrics.metrics.httpDuration.observe(
        {
          method: request.method,
          route: request.route?.path ?? 'unmatched',
          status: String(response.statusCode),
        },
        Number(process.hrtime.bigint() - started) / 1e9,
      );
    };

    // Both branches: an error response is exactly the latency worth measuring,
    // and recording only successes produces a graph that looks best during an
    // outage.
    return next.handle().pipe(tap({ next: record, error: record }));
  }
}

/**
 * The scrape endpoint.
 *
 * Guarded by a shared token rather than by the JWT guard, because a scraper has
 * no user and cannot refresh a session. Unset token means the route 404s: an
 * unconfigured deployment does not confirm the endpoint exists, let alone serve
 * spend and traffic figures to whoever asks.
 */
@Controller('metrics')
@Public()
@SkipThrottle()
export class MetricsController {
  constructor(
    private readonly metrics: ApiMetrics,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const expected = this.env.METRICS_TOKEN;

    if (!expected) throw new NotFoundException();

    const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';

    // Constant-time, and length-checked first because timingSafeEqual throws on
    // a length mismatch — which would itself leak the token's length through
    // the difference between a 401 and a 500.
    const ok =
      presented.length === expected.length &&
      timingSafeEqual(Buffer.from(presented), Buffer.from(expected));

    if (!ok) throw new UnauthorizedException();

    response
      .setHeader('content-type', this.metrics.metrics.registry.contentType)
      .send(await this.metrics.metrics.registry.metrics());
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [ApiMetrics, HttpMetricsInterceptor],
  exports: [ApiMetrics, HttpMetricsInterceptor],
})
export class MetricsModule {}
