import { Global, Injectable, Module } from '@nestjs/common';
import { createMetrics, type ExtractionOutcome, type Metrics } from '@invoiceiq/observability';

/**
 * The worker's view of itself, in numbers.
 *
 * A thin, typed facade over the shared metric definitions rather than injecting
 * the raw registry everywhere. Two reasons, both about the failure mode of raw
 * counters:
 *
 *   - A typo in a label value (`'need_review'`) is a silently empty panel. Here
 *     it is a compile error, because the outcome type is a union.
 *   - Recording is not worth failing a job over. A metrics backend hiccup must
 *     never take down the pipeline it is measuring, so every method is
 *     fire-and-forget by construction — none of them can throw into caller code
 *     doing real work.
 */
@Injectable()
export class PipelineMetrics {
  readonly metrics: Metrics = createMetrics();

  recordExtraction(outcome: ExtractionOutcome, seconds: number, cached: boolean): void {
    this.metrics.extractionTotal.inc({ outcome, cached: String(cached) });
    this.metrics.extractionDuration.observe({ outcome }, seconds);
  }

  recordSpend(model: string, costUsd: number, attempts: number): void {
    // A cache hit costs nothing; incrementing by zero would still create the
    // series, which is what makes "spend by model" readable rather than a graph
    // that appears only after the first live call.
    this.metrics.llmCostUsd.inc({ model }, costUsd);
    this.metrics.llmAttempts.observe(attempts);
  }

  recordCacheLookup(hit: boolean): void {
    this.metrics.cacheHits.inc({ result: hit ? 'hit' : 'miss' });
  }

  recordEscalation(from: string, to: string): void {
    this.metrics.escalations.inc({ from, to });
  }

  recordSpendCapRefusal(): void {
    this.metrics.spendCapRefusals.inc();
  }

  recordQueueDepth(queue: string, state: string, value: number): void {
    this.metrics.queueDepth.set({ queue, state }, value);
  }

  recordStranded(count: number): void {
    this.metrics.strandedDocuments.set(count);
  }

  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }

  contentType(): string {
    return this.metrics.registry.contentType;
  }
}

@Global()
@Module({
  providers: [PipelineMetrics],
  exports: [PipelineMetrics],
})
export class MetricsModule {}
