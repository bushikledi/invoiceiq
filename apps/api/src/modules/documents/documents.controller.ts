import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { interval, map, merge, type Observable } from 'rxjs';
import { systemClock } from '@invoiceiq/domain';
import type { ApiEnv } from '@invoiceiq/config';
import {
  CreateUploadRequestSchema,
  ListDocumentsQuerySchema,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type DocumentFileResponse,
  type DocumentSummary,
  type ListDocumentsQuery,
  type DocumentStats,
  type ListDocumentsResponse,
} from '@invoiceiq/contracts';
import type { AuthenticatedUser } from '@invoiceiq/contracts';
import { CurrentUser } from '../auth/auth.decorators.js';
import { ZodBody, ZodQuery } from '../../common/validation/zod-validation.pipe.js';
import { DocumentsService } from './documents.service.js';
import { StatsService } from './stats.service.js';
import { DocumentEventsService } from './document-events.service.js';
import { API_ENV } from '../../config/config.module.js';

/**
 * Documents.
 *
 * Protected by the global JwtAuthGuard — there is no @Public() here, so every
 * route requires a bearer token. Every handler passes the caller's id down to
 * the service, which scopes each query by owner.
 */
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly stats: StatsService,
    private readonly events: DocumentEventsService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** Step 1 of the upload dance: reserve a row, return a presigned PUT. */
  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  createUpload(
    @CurrentUser() user: AuthenticatedUser,
    @ZodBody(CreateUploadRequestSchema) body: CreateUploadRequest,
  ): Promise<CreateUploadResponse> {
    return this.documents.createUpload(user.id, body);
  }

  /** Step 3: the client confirms; the server verifies and queues. */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  completeUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentSummary> {
    return this.documents.completeUpload(user.id, id);
  }

  /**
   * Declared before `:id`, because Nest matches routes in declaration order and
   * `/documents/stats` would otherwise be parsed as a document id.
   */
  @Get('stats')
  statsFor(@CurrentUser() user: AuthenticatedUser): Promise<DocumentStats> {
    return this.stats.forUser(user.id);
  }

  /**
   * Live status updates, so the dashboard does not have to poll.
   *
   * Declared above `:id` for the same reason `stats` is: Nest matches in
   * declaration order, so `/documents/stream` below it is parsed as a document
   * id and rejected by ParseUUIDPipe with a 422 that mentions uuids and not the
   * route. This one is easy to get wrong twice, so it is worth saying twice.
   *
   * ## Why this is not an `EventSource` endpoint
   *
   * `EventSource` cannot set request headers. Authenticating it therefore means
   * putting the access token in the query string, where it is written to every
   * access log, proxy log and `Referer` header between here and the browser —
   * turning a 15-minute bearer token into a credential at rest in a dozen
   * places. The alternatives are a one-time stream ticket (a second endpoint
   * and a second token lifetime to reason about) or reading the stream with
   * `fetch`, which sends an ordinary `Authorization` header and reuses the
   * refresh handling the client already has. The client does the latter.
   *
   * So this route is protected by the same global guard as every other route,
   * with no special case, which is the point.
   *
   * ## Heartbeat
   *
   * Load balancers and reverse proxies close connections that go quiet, and a
   * dashboard watching an idle queue is quiet for a long time. A comment frame
   * every 20 seconds keeps the connection open without being an event the
   * client has to understand.
   */
  @Sse('stream')
  // A long-lived connection is one request that stays open, not a burst. Under
  // the global limiter a user with a few tabs would exhaust their quota by
  // reconnecting after a deploy, which is exactly when they most need to see
  // status. The connection count itself is bounded by the server's socket
  // limits, not by this.
  @SkipThrottle()
  stream(@CurrentUser() user: AuthenticatedUser): Observable<MessageEvent> {
    const updates = this.events
      .forUser(user.id)
      .pipe(map((event): MessageEvent => ({ type: 'status', data: event })));

    const heartbeat = interval(20_000).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: { at: systemClock.now().toISOString() } })),
    );

    return merge(updates, heartbeat);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @ZodQuery(ListDocumentsQuerySchema) query: ListDocumentsQuery,
  ): Promise<ListDocumentsResponse> {
    return this.documents.list(user.id, query);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentSummary> {
    return this.documents.get(user.id, id);
  }

  /** Presigned GET for the PDF viewer, valid for a few minutes. */
  @Get(':id/file')
  file(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentFileResponse> {
    return this.documents.fileUrl(user.id, id);
  }

  /**
   * Puts a failed or stranded document back on the queue.
   *
   * POST rather than PUT: this is not idempotent in the HTTP sense. Two calls
   * against a FAILED document produce one requeue and then a 409, which is the
   * honest answer — the second caller's intent has already been satisfied by
   * the first, and pretending otherwise would hide a double-click.
   */
  @Post(':id/requeue')
  @HttpCode(HttpStatus.OK)
  requeue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentSummary> {
    return this.documents.requeue(user.id, id, this.env.STRANDED_AFTER_MINUTES);
  }
}
