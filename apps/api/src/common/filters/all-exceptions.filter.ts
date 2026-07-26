import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';
import {
  buildProblem,
  type FieldError,
  type ProblemDetails,
  type ProblemType,
} from '@invoiceiq/contracts';
import { DomainError, isDomainError } from '@invoiceiq/domain';
import type { Response } from 'express';
import { currentTraceId } from '../trace/trace-context.js';

/**
 * Domain vocabulary in, transport vocabulary out. The domain never sees a
 * status code.
 *
 * A switch rather than a Record lookup: `noUncheckedIndexedAccess` widens every
 * index access to `| undefined`, and exhaustiveness checking here means adding
 * a DomainErrorKind without mapping it is a compile error rather than a silent
 * 500 in production.
 */
function domainKindToProblem(kind: DomainError['kind']): ProblemType {
  switch (kind) {
    case 'NOT_FOUND':
      return 'not_found';
    case 'CONFLICT':
      return 'conflict';
    case 'ILLEGAL_TRANSITION':
      return 'illegal_state_transition';
    case 'VALIDATION':
      return 'validation_error';
    case 'AUTHENTICATION':
      return 'authentication_error';
    case 'AUTHORIZATION':
      return 'authorization_error';
  }
}

/**
 * The single place an exception becomes an HTTP response.
 *
 * Two rules govern everything here:
 *  1. Every response body is a ProblemDetails envelope — no endpoint invents
 *     its own error shape.
 *  2. Unrecognised errors are bugs. They are logged in full and returned as a
 *     bare 500 carrying only a traceId; internal messages and stack traces
 *     never reach the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger(AllExceptionsFilter.name)
    private readonly logger: PinoLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const traceId = currentTraceId();
    const problem = this.toProblem(exception, traceId);

    if (problem.status >= 500) {
      this.logger.error({ err: exception, traceId, problem }, 'Unhandled exception');
    } else {
      this.logger.warn(
        { traceId, type: problem.type, status: problem.status, detail: problem.detail },
        'Request failed',
      );
    }

    if (response.headersSent) {
      // A streamed response (CSV export) already committed its status; all we
      // can do is terminate it rather than crash the process.
      response.end();
      return;
    }

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown, traceId: string): ProblemDetails {
    if (isDomainError(exception)) {
      return this.fromDomainError(exception, traceId);
    }

    if (exception instanceof ZodError) {
      return buildProblem({
        type: 'validation_error',
        traceId,
        detail: 'The request body did not match the expected schema.',
        errors: zodIssuesToFieldErrors(exception),
      });
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception, traceId);
    }

    return buildProblem({
      type: 'internal_error',
      traceId,
      detail: 'An unexpected error occurred. Quote the traceId when reporting this.',
    });
  }

  private fromDomainError(error: DomainError, traceId: string): ProblemDetails {
    const type = domainKindToProblem(error.kind);

    return buildProblem({
      type,
      traceId,
      detail: error.message,
      ...(type === 'validation_error' && 'issues' in error
        ? { errors: [...(error.issues as FieldError[])] }
        : {}),
    });
  }

  private fromHttpException(exception: HttpException, traceId: string): ProblemDetails {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    // Terminus signals a failed readiness check by throwing, and its payload
    // carries the per-indicator breakdown. Flattening that into the envelope
    // keeps the answer to "which dependency is down?" — collapsing it to
    // "Service Unavailable" turns a 5-second diagnosis into a 20-minute one.
    const health = asHealthCheckPayload(payload);
    if (health) {
      const failing = Object.entries(health.error);
      return buildProblem({
        type: 'upstream_error',
        traceId,
        status,
        detail:
          failing.length > 0
            ? `Dependencies unavailable: ${failing.map(([name]) => name).join(', ')}`
            : 'Readiness check failed',
        errors: failing.map(([name, info]) => ({
          path: name,
          message: typeof info.reason === 'string' ? info.reason : 'down',
        })),
      });
    }

    // Nest's built-in guards (throttler, payload limits) throw HttpExceptions.
    // Map the ones we care about onto our vocabulary so clients still branch on
    // a single stable `type` field.
    const type = statusToProblemType(status);

    const detail =
      typeof payload === 'string'
        ? payload
        : typeof payload === 'object' && payload !== null && 'message' in payload
          ? stringifyMessage(payload.message)
          : exception.message;

    return buildProblem({ type, traceId, status, detail });
  }
}

interface HealthCheckPayload {
  status: string;
  error: Record<string, { status?: string; reason?: unknown }>;
}

/** Narrows a Terminus HealthCheckResult out of an unknown exception payload. */
function asHealthCheckPayload(payload: unknown): HealthCheckPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;

  const candidate = payload as Partial<HealthCheckPayload>;
  if (typeof candidate.status !== 'string') return undefined;
  if (typeof candidate.error !== 'object' || candidate.error === null) return undefined;

  return candidate as HealthCheckPayload;
}

/**
 * Nest's built-in guards (throttler, payload limits, the default 404) throw
 * HttpExceptions. Mapping their statuses onto our vocabulary means clients
 * still branch on a single stable `type` field no matter who threw.
 *
 * A Map keyed by number rather than a switch over HttpStatus: `getStatus()`
 * returns `number`, and any framework can throw a status that is not an
 * HttpStatus member, so comparing the two as enums is the wrong model.
 */
const STATUS_TO_PROBLEM = new Map<number, ProblemType>([
  [HttpStatus.BAD_REQUEST, 'validation_error'],
  [HttpStatus.UNPROCESSABLE_ENTITY, 'validation_error'],
  [HttpStatus.UNAUTHORIZED, 'authentication_error'],
  [HttpStatus.FORBIDDEN, 'authorization_error'],
  [HttpStatus.NOT_FOUND, 'not_found'],
  [HttpStatus.CONFLICT, 'conflict'],
  [HttpStatus.PAYLOAD_TOO_LARGE, 'payload_too_large'],
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'unsupported_media_type'],
  [HttpStatus.TOO_MANY_REQUESTS, 'rate_limited'],
  [HttpStatus.BAD_GATEWAY, 'upstream_error'],
  [HttpStatus.SERVICE_UNAVAILABLE, 'upstream_error'],
  [HttpStatus.GATEWAY_TIMEOUT, 'upstream_error'],
]);

function statusToProblemType(status: number): ProblemType {
  return STATUS_TO_PROBLEM.get(status) ?? (status >= 500 ? 'internal_error' : 'validation_error');
}

function stringifyMessage(message: unknown): string {
  if (Array.isArray(message)) return message.map(String).join('; ');
  return String(message);
}

/** Flattens Zod issues into the envelope's `errors` array, preserving array indices. */
export function zodIssuesToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc === '' ? String(segment) : `${acc}.${String(segment)}`;
  }, '');
}
