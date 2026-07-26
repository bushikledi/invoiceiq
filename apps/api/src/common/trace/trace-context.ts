import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Request-scoped trace id, carried without threading a parameter through every
 * function signature.
 *
 * The same id is attached to the log line, returned in the error envelope, and
 * (from M7) copied into the BullMQ job payload — so one `grep` reconstructs a
 * document's entire life across the API and the worker.
 */
export interface TraceStore {
  traceId: string;
}

const storage = new AsyncLocalStorage<TraceStore>();

/** Runs `fn` with `traceId` bound to the current async context. */
export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn);
}

/**
 * The current trace id, or a generated one if called outside a request
 * (a queue job, a boot-time task). Never returns undefined: an error envelope
 * without a trace id is worse than one with an orphan id.
 */
export function currentTraceId(): string {
  return storage.getStore()?.traceId ?? newTraceId();
}

export function newTraceId(): string {
  return randomUUID();
}

/**
 * A client-supplied trace id is accepted only if it looks like one. Echoing
 * arbitrary client input into logs invites log injection and unbounded values.
 */
const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function sanitizeIncomingTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value) ? value : undefined;
}
