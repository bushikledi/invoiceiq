import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Metric definitions, shared by both processes.
 *
 * They live in a package rather than in each app for the same reason the
 * embedding configuration does: the two processes must agree, and a
 * disagreement is silent. If the worker exported `invoiceiq_extraction_total`
 * and the API exported `invoiceiq_extractions_total`, every dashboard and alert
 * would still render — showing half the truth, with nothing anywhere reporting
 * an error. Defining the names once makes the agreement structural.
 *
 * ## What is measured, and why these
 *
 * The set is small on purpose. Each one answers a question an operator actually
 * asks at 3am, and a metric nobody queries is a metric nobody maintains:
 *
 *   - *Is the pipeline moving?*      extraction_total, queue_depth
 *   - *Is it getting things right?*  needs_review_ratio (from the outcome label)
 *   - *Is it slow?*                  extraction_duration_seconds
 *   - *What is it costing me?*       llm_cost_usd_total, cache_hit_total
 *   - *Is it about to stop?*         spend_cap_refusal_total, stranded_documents
 *
 * ## Label discipline
 *
 * No label carries a document id, a user id, a filename or a model's free text.
 * Prometheus creates one time series per label combination, so an unbounded
 * label is not a slow query — it is an out-of-memory kill on the metrics
 * backend, caused by the monitoring rather than the thing monitored. Every
 * label below has a small, closed set of values.
 */

export const METRIC_PREFIX = 'invoiceiq_';

/** Outcome labels are a closed set — see the label-discipline note above. */
export type ExtractionOutcome = 'completed' | 'needs_review' | 'failed' | 'skipped';

export interface Metrics {
  readonly registry: Registry;
  readonly extractionTotal: Counter<'outcome' | 'cached'>;
  readonly extractionDuration: Histogram<'outcome'>;
  readonly llmCostUsd: Counter<'model'>;
  readonly llmAttempts: Histogram<never>;
  readonly cacheHits: Counter<'result'>;
  readonly escalations: Counter<'from' | 'to'>;
  readonly spendCapRefusals: Counter<never>;
  readonly queueDepth: Gauge<'queue' | 'state'>;
  readonly strandedDocuments: Gauge<never>;
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
}

/**
 * Builds a fresh registry and every metric on it.
 *
 * A registry per call rather than prom-client's global default: the global one
 * throws on duplicate registration, which turns a second call in a test file
 * into a failure that has nothing to do with what the test is checking.
 */
export function createMetrics(options: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();

  if (options.defaultMetrics !== false) {
    // Event-loop lag, heap, GC, open handles. Cheap, and the first thing worth
    // looking at when "the worker is slow" turns out to be "the worker is
    // blocked", which the pipeline metrics alone cannot distinguish.
    collectDefaultMetrics({ register: registry, prefix: METRIC_PREFIX });
  }

  return {
    registry,

    extractionTotal: new Counter({
      name: `${METRIC_PREFIX}extraction_total`,
      help: 'Extraction jobs finished, by outcome and whether the model output was reused',
      labelNames: ['outcome', 'cached'] as const,
      registers: [registry],
    }),

    extractionDuration: new Histogram({
      name: `${METRIC_PREFIX}extraction_duration_seconds`,
      help: 'Wall-clock time for a complete extraction job',
      labelNames: ['outcome'] as const,
      // Tuned to the real distribution: a cache hit lands under a second, a
      // single-attempt live call around 3–8s, and anything past 30s means the
      // repair loop is running. Default buckets top out at 10s, which would put
      // every interesting failure in +Inf.
      buckets: [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
      registers: [registry],
    }),

    llmCostUsd: new Counter({
      name: `${METRIC_PREFIX}llm_cost_usd_total`,
      help: 'Cumulative LLM spend in USD, by model',
      labelNames: ['model'] as const,
      registers: [registry],
    }),

    llmAttempts: new Histogram({
      name: `${METRIC_PREFIX}llm_attempts`,
      help: 'LLM calls per successful extraction; above 1 means the repair loop ran',
      buckets: [1, 2, 3, 4, 5],
      registers: [registry],
    }),

    cacheHits: new Counter({
      name: `${METRIC_PREFIX}extraction_cache_total`,
      help: 'Extraction cache lookups, by result',
      labelNames: ['result'] as const,
      registers: [registry],
    }),

    escalations: new Counter({
      name: `${METRIC_PREFIX}model_escalation_total`,
      help: 'Times a schema failure escalated an extraction to a more capable model',
      labelNames: ['from', 'to'] as const,
      registers: [registry],
    }),

    spendCapRefusals: new Counter({
      name: `${METRIC_PREFIX}spend_cap_refusal_total`,
      help: 'Extractions refused because the daily spend cap was already reached',
      registers: [registry],
    }),

    queueDepth: new Gauge({
      name: `${METRIC_PREFIX}queue_depth`,
      help: 'Jobs in a queue, by BullMQ state',
      labelNames: ['queue', 'state'] as const,
      registers: [registry],
    }),

    strandedDocuments: new Gauge({
      name: `${METRIC_PREFIX}stranded_documents`,
      help: 'Documents left in PROCESSING past the janitor threshold',
      registers: [registry],
    }),

    httpDuration: new Histogram({
      name: `${METRIC_PREFIX}http_request_duration_seconds`,
      help: 'API request latency',
      // `route` is the Nest route *pattern* (/documents/:id), never the
      // resolved path — the resolved path carries a uuid and would create one
      // time series per document.
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
  };
}
