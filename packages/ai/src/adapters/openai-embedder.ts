import { EmbeddingDimensionError, type EmbeddingProvider } from '../ports/embedding-provider.js';
import { LlmError } from '../ports/llm-extractor.js';

/**
 * OpenAI embeddings.
 *
 * Better quality than the local model and no CPU cost, at the price of a key
 * and a network round trip. Note the dimensionality difference: 1536 against
 * the local model's 384, so switching providers requires migrating the
 * pgvector column — the constructor takes the expected width and the adapter
 * refuses to return anything else.
 *
 * Written against the REST API directly rather than the SDK: this is one
 * endpoint with a three-field body, and the dependency would be larger than
 * the code it replaces.
 */
export interface OpenAiEmbeddingOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly baseUrl?: string;
}

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

interface EmbeddingApiResponse {
  data: { embedding: number[]; index: number }[];
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OpenAiEmbeddingOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        // text-embedding-3-* can be asked for fewer dimensions, which lets one
        // model serve a column of a different width if we ever need it to.
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      // Same retriable/terminal split as the extraction adapter: a 429 is worth
      // retrying, a 401 will fail identically forever.
      throw new LlmError(
        `OpenAI embeddings failed (${response.status}): ${body.slice(0, 200)}`,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as EmbeddingApiResponse;

    // The API does not guarantee input order in the response; each item carries
    // its index precisely because of that.
    const ordered = [...payload.data].sort((a, b) => a.index - b.index);
    const vectors = ordered.map((item) => item.embedding);

    const width = vectors[0]?.length ?? 0;
    if (width !== this.dimensions) {
      throw new EmbeddingDimensionError(this.dimensions, width, this.model);
    }

    return vectors;
  }
}
