import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Subject, filter, map, type Observable } from 'rxjs';
import {
  DOCUMENT_EVENTS_CHANNEL,
  DocumentEventMessageSchema,
  type DocumentEventMessage,
  type DocumentStreamEvent,
} from '@invoiceiq/contracts';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';

/**
 * Fans worker announcements out to connected browsers.
 *
 * ## One subscription, many listeners
 *
 * A single Redis subscriber serves every connected client, with an in-process
 * Subject doing the fan-out. The alternative — a Redis connection per SSE
 * client — turns fifty open dashboards into fifty connections to a server whose
 * connection limit is a real, finite number, and does so on the path where a
 * user refreshing repeatedly is the normal case.
 *
 * ioredis puts a connection into subscriber mode permanently on the first
 * SUBSCRIBE, refusing ordinary commands afterwards. Hence a dedicated
 * connection rather than sharing RedisService's, which the health check and the
 * queue both use for regular commands.
 *
 * ## Filtering is authorisation, and it happens here
 *
 * `forUser` filters on `uploaderId` before the event is mapped to its public
 * shape. Doing it in this order matters: the filter and the field-stripping are
 * the same operation, so there is no window in which an event for another user
 * exists in a form that could be written to the wrong stream.
 */
@Injectable()
export class DocumentEventsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DocumentEventsService.name);
  private readonly subscriber: Redis;
  private readonly events = new Subject<DocumentEventMessage>();

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.subscriber = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    this.subscriber.on('error', (error) => {
      // ioredis reconnects and re-subscribes on its own. Logging without
      // throwing keeps a Redis blip from taking down an API process whose other
      // endpoints are entirely unaffected by it.
      this.logger.warn(`Event subscriber: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.subscriber.connect();
    await this.subscriber.subscribe(DOCUMENT_EVENTS_CHANNEL);

    this.subscriber.on('message', (_channel, raw) => {
      // Parsed, not cast. This payload crosses a process boundary, so it is
      // untrusted in exactly the way any other input is — a malformed message
      // from a mismatched worker version should be dropped, not forwarded to a
      // browser that will render whatever it is handed.
      const parsed = DocumentEventMessageSchema.safeParse(safeJson(raw));

      if (!parsed.success) {
        this.logger.warn(`Discarding malformed document event: ${raw.slice(0, 200)}`);
        return;
      }

      this.events.next(parsed.data);
    });

    this.logger.log(`Subscribed to ${DOCUMENT_EVENTS_CHANNEL}`);
  }

  /** The caller's events only, stripped of the field that decided they were the caller's. */
  forUser(userId: string): Observable<DocumentStreamEvent> {
    return this.events.asObservable().pipe(
      filter((event) => event.uploaderId === userId),
      map(({ uploaderId: _uploaderId, ...event }) => event),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.events.complete();
    await this.subscriber.quit().catch(() => undefined);
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
