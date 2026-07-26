/**
 * Queue and job names shared between the API (producer) and the worker
 * (consumer).
 *
 * Duplicated deliberately rather than imported from apps/worker: apps must not
 * depend on one another (dependency-cruiser enforces it), and a queue name is
 * a wire contract, not shared code. The integration test asserts a job actually
 * lands on the queue the worker reads, which is what keeps the two honest.
 */
export const QUEUE_EXTRACTION = 'extraction' as const;
export const QUEUE_EMBEDDING = 'embedding' as const;

export const JOB_EXTRACT_DOCUMENT = 'extract-document' as const;
export const JOB_EMBED_DOCUMENT = 'embed-document' as const;
