'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DocumentStreamEventSchema, type DocumentStreamEvent } from '@invoiceiq/contracts';
import { getAccessToken, streamRequest } from './api-client';

/**
 * Live document status, with polling as the fallback rather than the mechanism.
 *
 * ## Why `fetch`, not `EventSource`
 *
 * `EventSource` cannot set request headers, so authenticating it means putting
 * the access token in the query string — where it lands in access logs, proxy
 * logs and `Referer` headers, turning a short-lived bearer token into a
 * credential at rest in places nobody is watching. Reading the stream with
 * `fetch` sends an ordinary `Authorization` header and reuses the refresh
 * handling the client already has.
 *
 * The cost is that reconnection is ours to implement, which `EventSource` would
 * have provided. That is the trade: a bounded amount of code here, against a
 * class of credential leak that is invisible until someone reads a log.
 *
 * ## The fallback is not decoration
 *
 * Redis pub/sub has no delivery guarantee, so an event published while this
 * connection was down is simply gone. The hook therefore reports whether it is
 * connected, and the screens keep polling — slowly — whenever it is not. The
 * database stays the source of truth; the stream only makes the UI feel
 * instant.
 */
export interface DocumentStream {
  /** True while the stream is live. Screens poll when it is false. */
  connected: boolean;
  /** The most recent event, for a transient "just updated" affordance. */
  lastEvent: DocumentStreamEvent | null;
}

/** Backoff for reconnection, in milliseconds. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** How long to gather events before refetching. Below the threshold of "instant". */
const COALESCE_MS = 250;

export function useDocumentStream(enabled = true): DocumentStream {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<DocumentStreamEvent | null>(null);

  // Held in a ref so a reconnect does not restart the effect and thereby cancel
  // the very connection it just opened.
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    /**
     * Coalesced invalidation.
     *
     * `invalidateQueries` refetches an *active* query immediately, and a single
     * document produces several events on its way through the pipeline —
     * PROCESSING, then COMPLETED — while a batch upload produces several
     * documents' worth at once. Invalidating per event turned a six-file drop
     * into dozens of refetches in a couple of seconds and tripped the API's
     * rate limiter, which then failed the very list the events were announcing.
     *
     * Waiting a beat and refetching once is strictly better: the extra frames
     * would have been thrown away by the next one anyway, and the user cannot
     * perceive the difference between "instant" and "instant plus 250ms".
     */
    const pendingDocuments = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      flushTimer = undefined;

      // Invalidate rather than patch the cache. The event carries a status, not
      // a document — writing a partial row into the list would leave every
      // other field stale, and the detail screen needs findings and confidence
      // the event does not have. One refetch of authoritative data beats a
      // cache assembled from fragments.
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['document-stats'] });

      // Only the documents actually mentioned. Invalidating the whole
      // ['document'] prefix would refetch every detail page the cache has ever
      // held, most of which nothing is looking at.
      for (const documentId of pendingDocuments) {
        void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      }
      pendingDocuments.clear();
    };

    const handle = (event: DocumentStreamEvent) => {
      setLastEvent(event);
      pendingDocuments.add(event.documentId);
      flushTimer ??= setTimeout(flush, COALESCE_MS);
    };

    const connect = async () => {
      if (stopped) return;

      try {
        await streamRequest('/documents/stream', controller.signal, (raw) => {
          const parsed = DocumentStreamEventSchema.safeParse(raw);
          if (parsed.success) handle(parsed.data);
        }, () => {
          // Fired on the first byte: the connection is real, so reset backoff.
          attemptRef.current = 0;
          setConnected(true);
        });
      } catch {
        /* Fall through to the reconnect below. */
      }

      if (stopped) return;

      setConnected(false);

      const delay = RETRY_MS[Math.min(attemptRef.current, RETRY_MS.length - 1)]!;
      attemptRef.current += 1;
      timer = setTimeout(() => void connect(), delay);
    };

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      // A pending flush after unmount would refetch queries nothing is
      // rendering, and React would warn about the state update behind it.
      if (flushTimer) clearTimeout(flushTimer);
      setConnected(false);
    };
    // `queryClient` is stable for the lifetime of the provider; listing it
    // keeps the lint rule satisfied without causing reconnects.
  }, [enabled, queryClient]);

  // With no token there is nothing to connect with, and reporting `connected`
  // would make the screens stop polling on the login screen.
  return { connected: connected && getAccessToken() !== null, lastEvent };
}
