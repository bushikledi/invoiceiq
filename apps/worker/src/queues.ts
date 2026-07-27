/**
 * Queue names and job contracts, shared by the API (producer) and the worker
 * (consumer). String literals for queue names are how you get a job that is
 * enqueued to a queue nobody consumes.
 */

export const QUEUE_EXTRACTION = 'extraction' as const;
export const QUEUE_EMBEDDING = 'embedding' as const;
/** Periodic housekeeping: reclaiming stranded documents, reporting queue depth. */
export const QUEUE_MAINTENANCE = 'maintenance' as const;

export const JOB_EXTRACT_DOCUMENT = 'extract-document' as const;
export const JOB_EMBED_DOCUMENT = 'embed-document' as const;
export const JOB_JANITOR = 'janitor' as const;

/**
 * Job id for a deliberate re-run, as opposed to the first enqueue of a document.
 *
 * The first enqueue uses the bare document id so BullMQ deduplicates a retried
 * upload. Reusing that id for a reclaim means `add()` finds the original — which
 * completed hours ago and is still retained — and silently returns it instead of
 * scheduling anything. The document sits in QUEUED with no job behind it, which
 * is worse than the crash being recovered from.
 *
 * Duplicate processing is prevented by the processor's status guard, not by this
 * id, so a fresh id per reclaim is safe.
 */
export const requeueJobId = (documentId: string, at: number): string =>
  `${documentId}:requeue:${at}`;

export interface ExtractDocumentJob {
  documentId: string;
  /** Lets the processor detect a stale job whose document has since changed. */
  contentSha256: string;
  /** Propagated from the HTTP request so worker logs join the same trace. */
  traceId: string;
}

export interface EmbedDocumentJob {
  documentId: string;
  extractionId: string;
  traceId: string;
}
