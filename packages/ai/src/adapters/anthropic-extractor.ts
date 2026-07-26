import Anthropic from '@anthropic-ai/sdk';
import type {
  ExtractionRequest,
  ExtractionResponse,
  LlmExtractor,
} from '../ports/llm-extractor.js';
import { LlmError } from '../ports/llm-extractor.js';
import { toLlmError } from './error-classification.js';
import { SYSTEM_PROMPT, buildUserPrompt } from '../prompts/extract-invoice.js';

export interface AnthropicExtractorOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly baseURL?: string;
}

/** The tool the model is forced to call. Its input schema is the invoice schema. */
const TOOL_NAME = 'record_invoice';

/**
 * Anthropic adapter using tool-use for structured output.
 *
 * Tool-use rather than "return JSON" in prose: the schema becomes part of the
 * API contract instead of a suggestion, so the model is constrained during
 * generation rather than corrected afterwards. `tool_choice` forces the call,
 * which removes the "here is your JSON:" preamble failure mode entirely.
 *
 * Temperature 0 because extraction is not a creative task — the same document
 * should produce the same answer, and any variation is noise we would have to
 * absorb in review.
 */
export class AnthropicLlmExtractor implements LlmExtractor {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicExtractorOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      // The worker owns retry policy via BullMQ; a second retry layer inside
      // the SDK would multiply attempts and make backoff unpredictable.
      maxRetries: 0,
    });
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 4_096;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          temperature: 0,
          system: SYSTEM_PROMPT,
          tools: [
            {
              name: TOOL_NAME,
              description: 'Record the structured data extracted from the invoice.',
              input_schema: request.schema as Anthropic.Tool['input_schema'],
            },
          ],
          // Forcing the tool removes the "I'll explain first" failure mode.
          tool_choice: { type: 'tool', name: TOOL_NAME },
          messages: [{ role: 'user', content: buildUserPrompt(request.text, request.feedback) }],
        },
        request.signal ? { signal: request.signal } : {},
      );

      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (!toolUse) {
        // Forced tool_choice makes this near-impossible, but a silent undefined
        // here would surface as a confusing Zod error three layers away.
        throw new LlmError(
          `Model returned no tool_use block (stop_reason: ${response.stop_reason})`,
          true,
        );
      }

      return {
        raw: toolUse.input,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        model: response.model,
      };
    } catch (error) {
      throw toLlmError(error);
    }
  }
}
