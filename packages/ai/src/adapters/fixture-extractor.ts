import type {
  ExtractionRequest,
  ExtractionResponse,
  LlmExtractor,
} from '../ports/llm-extractor.js';
import { LlmError } from '../ports/llm-extractor.js';

/**
 * Replays recorded LLM responses.
 *
 * This is what makes the whole pipeline testable. Every PR runs the real
 * worker — real queue, real database, real validation, real persistence —
 * against recorded model output, so the tests are fast, free, and identical
 * on every run. The real provider is exercised separately by the nightly
 * contract job, where drift is what we are looking for.
 *
 * A scenario may hold several responses. That is how the retry path is tested:
 * `malformed-then-valid` returns a broken payload first and a good one second,
 * so `extractWithRepair` genuinely walks its corrective loop rather than being
 * told it did.
 */

export interface FixtureScenario {
  /** Returned in order, one per call. */
  readonly responses: readonly unknown[];
  readonly model?: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
  /** When set, the extractor throws instead of returning — for error-path tests. */
  readonly error?: { message: string; retriable: boolean };
}

export type FixtureLibrary = Readonly<Record<string, FixtureScenario>>;

const DEFAULT_USAGE = { inputTokens: 1_200, outputTokens: 380 };
const DEFAULT_MODEL = 'fixture-model';

export class FixtureLlmExtractor implements LlmExtractor {
  /** Every request seen, so tests can assert on call count and feedback content. */
  readonly calls: ExtractionRequest[] = [];

  private index = 0;

  constructor(
    private readonly library: FixtureLibrary,
    private scenario: string,
  ) {
    this.assertScenarioExists(scenario);
  }

  /** Switches scenario mid-test and rewinds the response pointer. */
  use(scenario: string): void {
    this.assertScenarioExists(scenario);
    this.scenario = scenario;
    this.index = 0;
  }

  get callCount(): number {
    return this.calls.length;
  }

  reset(): void {
    this.calls.length = 0;
    this.index = 0;
  }

  extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    this.calls.push(request);

    const scenario = this.library[this.scenario]!;

    if (scenario.error) {
      return Promise.reject(new LlmError(scenario.error.message, scenario.error.retriable));
    }

    // Past the end, the last response repeats. A fixture that ran out mid-test
    // would otherwise fail with an opaque undefined rather than the assertion
    // the test actually cares about.
    const position = Math.min(this.index, scenario.responses.length - 1);
    this.index += 1;

    return Promise.resolve({
      raw: scenario.responses[position],
      usage: scenario.usage ?? DEFAULT_USAGE,
      model: scenario.model ?? DEFAULT_MODEL,
    });
  }

  private assertScenarioExists(name: string): void {
    if (!(name in this.library)) {
      const available = Object.keys(this.library).join(', ');
      throw new Error(`Unknown fixture scenario "${name}". Available: ${available}`);
    }
  }
}
