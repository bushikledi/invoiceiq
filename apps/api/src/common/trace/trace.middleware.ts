import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newTraceId, runWithTrace, sanitizeIncomingTraceId } from './trace-context.js';

export const TRACE_HEADER = 'x-trace-id';

/**
 * Opens an AsyncLocalStorage scope for every request and echoes the id back on
 * the response, so a user reporting "it failed" can hand over something that
 * finds the exact log line.
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const traceId = sanitizeIncomingTraceId(req.headers[TRACE_HEADER]) ?? newTraceId();

    res.setHeader(TRACE_HEADER, traceId);

    runWithTrace(traceId, () => {
      next();
    });
  }
}
