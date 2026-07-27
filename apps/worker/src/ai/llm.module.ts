import { Global, Logger, Module } from '@nestjs/common';
import {
  AnthropicLlmExtractor,
  FIXTURES,
  FixtureLlmExtractor,
  SpendCappedExtractor,
  TieredLlmExtractor,
  resolveScenarioFromText,
  type LlmExtractor,
} from '@invoiceiq/ai';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../config/config.module.js';
import { PrismaModule } from '../infrastructure/prisma/prisma.module.js';
import { ExtractionCacheService } from '../pipeline/extraction-cache.service.js';
import { PipelineMetrics } from '../observability/pipeline.metrics.js';

/** DI token for whichever extractor the environment selected. */
export const LLM_EXTRACTOR = Symbol('LLM_EXTRACTOR');

/**
 * Chooses the extractor from configuration and wraps it in its cost controls.
 *
 * The composition is deliberate and the order matters:
 *
 *   SpendCapped( Tiered( Anthropic(cheap), Anthropic(strong) ) )
 *
 * The cap is outermost so it is checked before any tier is selected — a budget
 * that only applies to the cheap model would be exactly backwards, since
 * escalation is what makes a runaway loop expensive.
 *
 * This is also the seam that makes the pipeline testable. Integration tests
 * inject the fixture replayer through the same token, so the worker under test
 * is the real worker — real queue, real database, real transactions — with only
 * the network boundary swapped. Nothing about the pipeline knows or cares which
 * implementation it got.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    ExtractionCacheService,
    {
      provide: LLM_EXTRACTOR,
      inject: [WORKER_ENV, ExtractionCacheService, PipelineMetrics],
      useFactory: (
        env: WorkerEnv,
        cache: ExtractionCacheService,
        metrics: PipelineMetrics,
      ): LlmExtractor => {
        const logger = new Logger('LlmModule');

        const base = buildProvider(env, logger, metrics);

        if (env.LLM_DAILY_SPEND_CAP_USD <= 0) {
          logger.warn('LLM_DAILY_SPEND_CAP_USD is 0 — spend is unbounded by this process');
          return base;
        }

        return new SpendCappedExtractor(base, {
          capUsd: env.LLM_DAILY_SPEND_CAP_USD,
          spentUsd: () => cache.spentTodayUsd(),
          onRefuse: ({ spentUsd, capUsd }) => {
            metrics.recordSpendCapRefusal();
            logger.error(`Spend cap reached: $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}`);
          },
        });
      },
    },
  ],
  exports: [LLM_EXTRACTOR, ExtractionCacheService],
})
export class LlmModule {}

function buildProvider(env: WorkerEnv, logger: Logger, metrics: PipelineMetrics): LlmExtractor {
  if (env.LLM_PROVIDER !== 'anthropic') {
    logger.warn(
      'Using recorded fixtures — no LLM calls will be made. ' +
        'Set ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic to go live.',
    );
    return new FixtureLlmExtractor(FIXTURES, 'clean-invoice', resolveScenarioFromText);
  }

  if (!env.ANTHROPIC_API_KEY) {
    // Should be unreachable: the env schema refines on this. Belt and braces,
    // because the failure mode otherwise is a 401 per document.
    throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  const tier = (model: string) => ({
    model,
    extractor: new AnthropicLlmExtractor({ apiKey, model }),
  });

  // A fallback identical to the primary is not a ladder, and pretending it is
  // one would put a misleading escalation event in the logs.
  if (env.LLM_MODEL_FALLBACK === env.LLM_MODEL) {
    logger.log(`Using Anthropic (${env.LLM_MODEL}, no escalation tier)`);
    return tier(env.LLM_MODEL).extractor;
  }

  logger.log(`Using Anthropic (${env.LLM_MODEL} → ${env.LLM_MODEL_FALLBACK} on schema failure)`);

  return new TieredLlmExtractor([tier(env.LLM_MODEL), tier(env.LLM_MODEL_FALLBACK)], {
    attemptsPerTier: env.LLM_TIER_ATTEMPTS,
    onEscalate: ({ attempt, from, to }) => {
      metrics.recordEscalation(from, to);
      logger.warn(`Attempt ${attempt}: escalating ${from} → ${to}`);
    },
  });
}
