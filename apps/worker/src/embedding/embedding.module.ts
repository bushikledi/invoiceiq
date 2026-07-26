import { Global, Logger, Module } from '@nestjs/common';
import {
  DeterministicEmbeddingProvider,
  LocalEmbeddingProvider,
  OpenAiEmbeddingProvider,
  type EmbeddingProvider,
} from '@invoiceiq/ai';
import type { WorkerEnv } from '@invoiceiq/config';
import { WORKER_ENV } from '../config/config.module.js';

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

/**
 * Selects the embedding provider from configuration.
 *
 * The dimension check is the important part. The pgvector column is declared
 * `vector(384)`, so pointing EMBEDDING_PROVIDER at OpenAI without migrating
 * would fail on the first insert of the first document — long after deploy, in
 * a background job, as an opaque Postgres error. Failing at boot with a message
 * naming both numbers is worth the four lines.
 */
@Global()
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [WORKER_ENV],
      useFactory: (env: WorkerEnv): EmbeddingProvider => {
        const logger = new Logger('EmbeddingModule');

        const provider = build(env);

        if (provider.dimensions !== env.EMBEDDING_DIM) {
          throw new Error(
            `EMBEDDING_PROVIDER=${env.EMBEDDING_PROVIDER} produces ${provider.dimensions}-dimension ` +
              `vectors but EMBEDDING_DIM is ${env.EMBEDDING_DIM}. The document_chunks.embedding ` +
              `column must match; changing provider requires a migration.`,
          );
        }

        logger.log(`Embeddings: ${provider.model} (${provider.dimensions}d)`);
        return provider;
      },
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingModule {}

function build(env: WorkerEnv): EmbeddingProvider {
  switch (env.EMBEDDING_PROVIDER) {
    case 'openai':
      if (!env.OPENAI_API_KEY) {
        throw new Error('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY');
      }
      return new OpenAiEmbeddingProvider({
        apiKey: env.OPENAI_API_KEY,
        dimensions: env.EMBEDDING_DIM,
      });

    case 'deterministic':
      return new DeterministicEmbeddingProvider(env.EMBEDDING_DIM);

    case 'local':
    default:
      return new LocalEmbeddingProvider({
        model: env.EMBEDDING_MODEL,
        dimensions: env.EMBEDDING_DIM,
      });
  }
}
