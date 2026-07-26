import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerAppModule } from './app.module.js';

/**
 * Standalone application context — no HTTP server, no port.
 *
 * Graceful drain is the point of this file. On SIGTERM (every deploy, every
 * autoscale-down) Nest runs shutdown hooks, which closes the BullMQ workers.
 * BullMQ's `close()` waits for the in-flight job to finish rather than killing
 * it, so a document is never stranded mid-PROCESSING with nothing coming back
 * for it. The M11 janitor exists for the cases this cannot cover — SIGKILL, OOM
 * — but it should be rare, not the primary mechanism.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const logger = app.get(Logger);
  logger.log(`Worker started (pid ${process.pid})`);

  // Nest's shutdown hooks handle SIGTERM/SIGINT once enableShutdownHooks() is
  // called, but an unhandled rejection would otherwise take the process down
  // without draining. Log it and let the platform restart us cleanly.
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${String(reason)}`);
  });
}

void bootstrap();
