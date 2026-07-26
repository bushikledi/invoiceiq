/**
 * Queue names and job contracts, shared by the API (producer) and the worker
 * (consumer). String literals for queue names are how you get a job that is
 * enqueued to a queue nobody consumes.
 */

export const QUEUE_EXTRACTION = 'extraction' as const;
export const QUEUE_EMBEDDING = 'embedding' as const;

export const JOB_EXTRACT_DOCUMENT = 'extract-document' as const;
export const JOB_EMBED_DOCUMENT = 'embed-document' as const;

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
