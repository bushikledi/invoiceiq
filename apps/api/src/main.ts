import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { loadApiEnv } from '@invoiceiq/config';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const env = loadApiEnv(process.env);

  const app = await NestFactory.create(AppModule, {
    // Suppress Nest's own console logger; pino takes over below so there is
    // exactly one log format on stdout.
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  app.setGlobalPrefix('api/v1');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  // The refresh token arrives as an httpOnly cookie, so it never passes through
  // JavaScript on the client and is not readable by XSS.
  app.use(cookieParser());

  // Exact origins only. A wildcard is incompatible with credentialed requests,
  // and the refresh token travels as a cookie.
  app.enableCors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Trace-Id'],
    exposedHeaders: ['X-Trace-Id'],
    maxAge: 86_400,
  });

  // Lets Nest run onModuleDestroy hooks on SIGTERM: Prisma disconnects and
  // Redis quits cleanly instead of the platform killing the process mid-query.
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');

  app.get(Logger).log(`API listening on :${env.PORT} (${env.NODE_ENV})`);
}

void bootstrap();
