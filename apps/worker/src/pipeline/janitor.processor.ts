import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  assertTransition,
  isStranded,
  reclaimAfterMinutes,
  systemClock,
  RECLAIMABLE_STATUSES,
  type DocumentStatus,
} from '@invoiceiq/domain';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../config/config.module.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { PipelineMetrics } from '../observability/pipeline.metrics.js';
import {
  JOB_EXTRACT_DOCUMENT,
  JOB_JANITOR,
  QUEUE_EMBEDDING,
  QUEUE_EXTRACTION,
  QUEUE_MAINTENANCE,
  requeueJobId,
} from '../queues.js';

/**
 * Reclaims documents that no worker is coming back for.
 *
 * Graceful shutdown covers the ordinary case: on SIGTERM, BullMQ finishes the
 * in-flight job before closing. This exists for the cases nothing can drain —
 * SIGKILL, an OOM kill, a node disappearing. Without it, the surviving evidence
 * of a crash is a document that says PROCESSING forever, and the only fix is a
 * human running UPDATE against production.
 *
 * ## Why a repeatable job, not a cron in the process
 *
 * `@nestjs/schedule` would run this cron in *every* replica. With three workers
 * that is three janitors waking simultaneously, each selecting the same
 * stranded rows, each enqueueing the same recovery. The row update is
 * conditional so the database would survive it, but it is a race deliberately
 * introduced by the recovery mechanism, which is the wrong place to have one.
 *
 * A BullMQ repeatable job is coordinated through Redis: one instance fires per
 * interval no matter how many workers are running. The queue we already depend
 * on solves the leader-election problem we would otherwise have to solve.
 *
 * Requeueing is safe because the extraction processor's status guard refuses
 * anything that is not QUEUED, and the job id is the document id — so even if
 * the original worker were somehow still alive and finished late, the recovered
 * job would find a non-QUEUED document and acknowledge itself without working.
 */
@Processor(QUEUE_MAINTENANCE)
export class JanitorProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(JanitorProcessor.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly metrics: PipelineMetrics,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @InjectQueue(QUEUE_MAINTENANCE) private readonly maintenance: Queue,
    @InjectQueue(QUEUE_EXTRACTION) private readonly extraction: Queue,
    @InjectQueue(QUEUE_EMBEDDING) private readonly embedding: Queue,
  ) {
    super();
  }

  /**
   * Registers the schedule on boot.
   *
   * The repeat key is derived from the job name and interval, so restarting a
   * worker re-registers the same schedule rather than adding a second one — and
   * changing the interval replaces the old schedule instead of leaving an
   * orphan firing at the previous rate forever.
   */
  async onApplicationBootstrap(): Promise<void> {
    const every = this.env.JANITOR_INTERVAL_MINUTES * 60_000;

    await this.maintenance.add(
      JOB_JANITOR,
      {},
      {
        // `immediately` matters more than it looks. Without it the first run is
        // one full interval away, so a worker that boots after a crash — the
        // exact moment documents are most likely to be stranded — leaves them
        // stranded for another five minutes, and reports no queue depth at all
        // until then. The repeat scheduler still fires it once across replicas.
        repeat: { every, immediately: true },
        jobId: `${JOB_JANITOR}-${every}`,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      },
    );

    this.logger.log(`Janitor scheduled every ${this.env.JANITOR_INTERVAL_MINUTES}m`);
  }

  async process(): Promise<{ reclaimed: number }> {
    await this.reportQueueDepth();
    return { reclaimed: await this.reclaimStranded() };
  }

  private async reclaimStranded(): Promise<number> {
    const now = systemClock.now();
    const threshold = this.env.STRANDED_AFTER_MINUTES;

    // Prefilter in SQL at the *shortest* of the per-status thresholds, then let
    // the policy make the actual decision. The query is an index-friendly
    // narrowing, not a second implementation of the rule — using the shortest
    // window guarantees it never excludes a row the policy would have
    // reclaimed, and the boundary cases stay decided in one unit-tested place.
    const candidates = await this.prismaService.client.document.findMany({
      where: {
        status: { in: RECLAIMABLE_STATUSES },
        updatedAt: { lte: new Date(now.getTime() - threshold * 60_000) },
      },
      select: { id: true, status: true, updatedAt: true, contentSha256: true },
      take: 100,
    });

    const stranded = candidates.filter((d) => isStranded(d, now, threshold));
    this.metrics.recordStranded(stranded.length);

    if (stranded.length === 0) return 0;

    this.logger.warn(`Reclaiming ${stranded.length} stranded document(s)`);

    let reclaimed = 0;

    for (const document of stranded) {
      try {
        await this.requeue(document.id, document.status, document.contentSha256);
        reclaimed++;
      } catch (error) {
        // One document that cannot be reclaimed must not stop the other
        // ninety-nine. The next run will try it again.
        this.logger.error(`Could not reclaim ${document.id}: ${String(error)}`);
      }
    }

    return reclaimed;
  }

  private async requeue(
    documentId: string,
    from: DocumentStatus,
    contentSha256: string | null,
  ): Promise<void> {
    await this.prismaService.client.$transaction(async (tx) => {
      // Re-read inside the transaction. The document may have completed between
      // the SELECT above and now — a worker finishing a job just as the janitor
      // decided it was dead — and rewriting it to QUEUED would undo real work.
      const current = await tx.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { status: true },
      });

      if (current.status !== from) {
        throw new Error(`no longer stranded (now ${current.status})`);
      }

      // A QUEUED document is already in the target status: there is no
      // transition to assert and no row to update, only a job to re-create.
      // Writing QUEUED over QUEUED would bump updatedAt and reset the very
      // timer that identified it as stuck, so a document with no job would be
      // rediscovered on every run and never actually recovered.
      if (from !== 'QUEUED') {
        assertTransition(from, 'QUEUED');
        await tx.document.update({ where: { id: documentId }, data: { status: 'QUEUED' } });
      }

      await tx.documentEvent.create({
        data: {
          documentId,
          type: 'RECLAIMED',
          payload: {
            from,
            to: 'QUEUED',
            reason: `stuck in ${from} for more than ${reclaimAfterMinutes(from, this.env.STRANDED_AFTER_MINUTES) ?? '?'}m`,
            by: 'janitor',
          },
        },
      });
    });

    // Enqueued after the commit, for the same reason the embedding job is: a
    // job firing on a transaction that then rolls back would process a document
    // the database still believes is PROCESSING.
    await this.extraction.add(
      JOB_EXTRACT_DOCUMENT,
      { documentId, contentSha256: contentSha256 ?? '', traceId: `janitor-${documentId}` },
      { jobId: requeueJobId(documentId, systemClock.now().getTime()) },
    );
  }

  /**
   * Publishes queue depth as a gauge.
   *
   * Depth is the metric that distinguishes "nothing is happening because there
   * is no work" from "nothing is happening because the workers are wedged" —
   * two states that look identical on a throughput graph and call for opposite
   * responses.
   */
  private async reportQueueDepth(): Promise<void> {
    for (const [name, queue] of [
      [QUEUE_EXTRACTION, this.extraction],
      [QUEUE_EMBEDDING, this.embedding],
    ] as const) {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, value] of Object.entries(counts)) {
          this.metrics.recordQueueDepth(name, state, value);
        }
      } catch (error) {
        this.logger.warn(`Could not read ${name} depth: ${String(error)}`);
      }
    }
  }
}
