import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../config/config.module.js';
import { PipelineMetrics } from './pipeline.metrics.js';

/**
 * A two-endpoint HTTP surface on an otherwise headless process.
 *
 * The worker is a standalone Nest context with no HTTP adapter, which is
 * correct — it consumes a queue, it does not serve requests. But an unscrapeable
 * process is an unobservable one, and "the worker is fine, we think" is not an
 * operational position.
 *
 * Deliberately `node:http` rather than mounting Nest's HTTP adapter. The
 * adapter would bring controllers, pipes, guards and middleware into a process
 * that needs none of them, and — more to the point — it would make adding a
 * third endpoint easy. Two hand-written routes keep the surface honestly
 * closed: anything else is a 404, so the worker cannot quietly grow an API.
 *
 * This port must not be public. It exposes no document data, but it does
 * publish spend, queue depth and process internals, and none of that belongs to
 * the internet. In the deployment guide it is bound to the private network.
 */
@Injectable()
export class MetricsServerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MetricsServerService.name);
  private server: Server | null = null;

  constructor(
    private readonly metrics: PipelineMetrics,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  onModuleInit(): void {
    if (this.env.WORKER_METRICS_PORT <= 0) {
      this.logger.log('Metrics server disabled (WORKER_METRICS_PORT=0)');
      return;
    }

    this.server = createServer((req, res) => {
      void this.handle(req.url ?? '/', res);
    });

    this.server.on('error', (error) => {
      // A port clash must not take the worker down. The pipeline is the job;
      // metrics are how we watch it, and losing the view is not losing the work.
      this.logger.error(`Metrics server failed: ${error.message}`);
    });

    this.server.listen(this.env.WORKER_METRICS_PORT, () => {
      this.logger.log(`Metrics on :${this.env.WORKER_METRICS_PORT}/metrics`);
    });
  }

  private async handle(url: string, res: ServerResponse): Promise<void> {
    const path = url.split('?')[0];

    if (path === '/metrics') {
      try {
        const body = await this.metrics.scrape();
        res.writeHead(200, { 'content-type': this.metrics.contentType() }).end(body);
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
      return;
    }

    if (path === '/health') {
      // Liveness only. The worker's readiness is "is it consuming jobs", which
      // the heartbeat row in the database answers far better than a process
      // that is by definition alive enough to reply to this.
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }

    res.writeHead(404).end();
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (!server) return;

    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
