import { EmbeddingDimensionError, type EmbeddingProvider } from '../ports/embedding-provider.js';

/**
 * Multilingual MiniLM, running in-process.
 *
 * This is what makes semantic search work with no API key at all — which
 * matters here because the Italian sample invoices need a multilingual model,
 * and "search is dead until you add a key" would leave the most interesting
 * part of the project undemonstrable.
 *
 * The costs are real and worth stating: a ~120 MB model download on first use,
 * and CPU per document instead of a network call. For a corpus of this size
 * that is a good trade; at a million documents it would not be, and the OpenAI
 * adapter behind the same port is the answer then.
 */
export interface LocalEmbeddingOptions {
  readonly model?: string;
  readonly dimensions?: number;
  /** Where to cache the downloaded model. Baked into the image at build time. */
  readonly cacheDir?: string;
}

const DEFAULT_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const DEFAULT_DIMENSIONS = 384;

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  private pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;
  private readonly cacheDir: string | undefined;

  constructor(options: LocalEmbeddingOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.cacheDir = options.cacheDir;
  }

  /**
   * Loads the model once, on first use.
   *
   * Deliberately lazy: the import pulls in a large ONNX runtime, and an API
   * process that never embeds anything should not pay for it. The promise is
   * cached rather than the pipeline, so concurrent first calls await one load
   * instead of racing to download the same model twice.
   */
  private async pipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= (async () => {
      const transformers = await import('@huggingface/transformers');

      if (this.cacheDir) {
        transformers.env.cacheDir = this.cacheDir;
      }
      // Never reach for a remote model at request time in production; the
      // image bakes it in and a surprise download would look like a hang.
      transformers.env.allowRemoteModels = true;

      const extractor = await transformers.pipeline('feature-extraction', this.model, {
        dtype: 'fp32',
      });

      // The SDK already resolves this to a callable matching our signature, so
      // no assertion is needed — the local FeatureExtractionPipeline type just
      // documents the one call shape we depend on.
      return extractor;
    })();

    return this.pipelinePromise;
  }

  /** Downloads and warms the model. Called at worker boot so the first job is not slow. */
  async warm(): Promise<void> {
    await this.embed(['warm-up']);
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extract = await this.pipeline();

    // Mean pooling over tokens, then L2 normalisation — the standard recipe for
    // sentence-transformers models, and what makes cosine distance meaningful.
    const output = await extract([...texts], { pooling: 'mean', normalize: true });
    const vectors = output.tolist();

    const width = vectors[0]?.length ?? 0;
    if (width !== this.dimensions) {
      // Caught here rather than as a Postgres error on the first insert, which
      // would surface as a failed job with an opaque message.
      throw new EmbeddingDimensionError(this.dimensions, width, this.model);
    }

    return vectors;
  }
}
