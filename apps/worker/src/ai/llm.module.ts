import { Global, Logger, Module } from '@nestjs/common';
import {
  AnthropicLlmExtractor,
  FIXTURES,
  FixtureLlmExtractor,
  type LlmExtractor,
} from '@invoiceiq/ai';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../config/config.module.js';

/** DI token for whichever extractor the environment selected. */
export const LLM_EXTRACTOR = Symbol('LLM_EXTRACTOR');

/**
 * Chooses the extractor from configuration.
 *
 * This is the seam that makes the pipeline testable. Integration tests inject
 * the fixture replayer through the same token, so the worker under test is the
 * real worker — real queue, real database, real transactions — with only the
 * network boundary swapped. Nothing about the pipeline knows or cares which
 * implementation it got.
 */
@Global()
@Module({
  providers: [
    {
      provide: LLM_EXTRACTOR,
      inject: [WORKER_ENV],
      useFactory: (env: WorkerEnv): LlmExtractor => {
        const logger = new Logger('LlmModule');

        if (env.LLM_PROVIDER === 'anthropic') {
          if (!env.ANTHROPIC_API_KEY) {
            // Should be unreachable: the env schema refines on this. Belt and
            // braces, because the failure mode otherwise is a 401 per document.
            throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
          }
          logger.log(`Using Anthropic (${env.LLM_MODEL})`);
          return new AnthropicLlmExtractor({
            apiKey: env.ANTHROPIC_API_KEY,
            model: env.LLM_MODEL,
          });
        }

        logger.warn(
          'Using recorded fixtures — no LLM calls will be made. ' +
            'Set ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic to go live.',
        );
        return new FixtureLlmExtractor(FIXTURES, 'clean-invoice');
      },
    },
  ],
  exports: [LLM_EXTRACTOR],
})
export class LlmModule {}
