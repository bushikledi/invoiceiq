import type { Params } from 'nestjs-pino';
import type { ApiEnv } from '@invoiceiq/config';
import { TRACE_HEADER } from '../common/trace/trace.middleware.js';
import { currentTraceId } from '../common/trace/trace-context.js';

/**
 * Structured JSON logs to stdout, one line per event, with the trace id on
 * every line so a document's whole life can be reconstructed with one grep.
 *
 * Redaction is not optional here. Invoices are commercial PII, and auth headers
 * and cookies are live credentials — anything logged is likely to end up in a
 * third-party aggregator.
 */
export function buildLoggerConfig(env: ApiEnv): Params {
  const isDevelopment = env.NODE_ENV === 'development';

  return {
    pinoHttp: {
      level: env.LOG_LEVEL,

      // Pretty output is a development affordance only; production must stay
      // machine-parseable.
      transport: isDevelopment
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss.l' } }
        : undefined,

      // Attach the AsyncLocalStorage trace id to every line, including logs
      // emitted deep inside a service with no access to the request object.
      mixin: () => ({ traceId: currentTraceId() }),

      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.refreshToken',
          '*.passwordHash',
          '*.tokenHash',
          '*.accessToken',
          '*.refreshToken',
          '*.apiKey',
        ],
        censor: '[redacted]',
      },

      customProps: (req) => ({
        traceId: (req.headers[TRACE_HEADER] as string | undefined) ?? currentTraceId(),
      }),

      // Health checks would otherwise dominate the log volume.
      autoLogging: {
        ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false,
      },

      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    },
  };
}
