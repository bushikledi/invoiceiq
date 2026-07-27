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

/**
 * Job id for a *deliberate* re-run — a manual requeue or a janitor reclaim.
 *
 * The first enqueue of a document uses the bare document id, which makes BullMQ
 * deduplicate: a lost HTTP response and a client retry produce one job, not two
 * LLM bills. That is exactly right for "the same upload, submitted twice".
 *
 * It is exactly wrong for "run this document again". BullMQ refuses an `add()`
 * whose id already exists, and completed jobs are retained for an hour — so a
 * requeue an hour after the original silently did nothing at all. The document
 * moved to QUEUED in the database and no job existed to move it out again,
 * which is a worse state than the failure being recovered from, and it fails
 * *silently*: `add()` returns the old job rather than throwing.
 *
 * So recovery gets a fresh id. Uniqueness is not what keeps a document from
 * being processed twice — the processor's status guard is, and it holds no
 * matter how many jobs arrive.
 */
export const requeueJobId = (documentId: string, at: number): string =>
  `${documentId}:requeue:${at}`;
