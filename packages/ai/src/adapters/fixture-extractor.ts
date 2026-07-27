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
 * against recorded model output, so the tests are fast, free, and identical on
 * every run. The real provider is exercised separately by the nightly contract
 * job, where drift is what we are looking for.
 *
 * STATELESS BY CONSTRUCTION. The worker holds one extractor for its entire
 * lifetime and processes documents concurrently, so per-extraction state on the
 * instance would be a data race waiting to happen: two documents interleaving
 * would each read the other's scenario, and the result would be an extraction
 * that parses, validates and scores perfectly well while belonging to the wrong
 * invoice — with nothing thrown anywhere.
 *
 * Everything needed to answer a call therefore comes from the call: the
 * scenario is resolved from the request text, and the position within a
 * multi-response scenario comes from `request.attempt`.
 *
 * (An earlier version did hold that state. It was replaced pre-emptively rather
 * than in response to an observed failure — the cross-document symptom that
 * prompted the look turned out to be several stale worker processes left
 * running against one queue.)
 */

export interface FixtureScenario {
  /** Returned in order, indexed by attempt number. */
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

  /**
   * Fixtures answer as `fixture-model`, and the extraction cache keys on it.
   * A scenario that overrides `model` records that instead, so a hit requires
   * the same scenario — which is the honest comparison.
   */
  readonly modelId = DEFAULT_MODEL;

  constructor(
    private readonly library: FixtureLibrary,
    /** Used whenever the resolver finds no match. */
    private defaultScenario: string,
    /**
     * Optionally picks the scenario from the document text.
     *
     * Without this, fixture mode replays one canned response for every
     * document, so uploading the sum-mismatch sample would return the clean
     * invoice and the demo would show a document that validates perfectly.
     * Matching the response to the document it was given is what makes a
     * keyless run behave like the real thing.
     */
    private readonly resolveScenario?: (text: string) => string | undefined,
  ) {
    this.assertScenarioExists(defaultScenario);
  }

  /** Pins the scenario for tests that drive it explicitly. */
  use(scenario: string): void {
    this.assertScenarioExists(scenario);
    this.defaultScenario = scenario;
  }

  get callCount(): number {
    return this.calls.length;
  }

  reset(): void {
    this.calls.length = 0;
  }

  extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    this.calls.push(request);

    const name = this.scenarioFor(request);
    const scenario = this.library[name]!;

    if (scenario.error) {
      return Promise.reject(new LlmError(scenario.error.message, scenario.error.retriable));
    }

    // Attempt is 1-based. Past the end, the last response repeats: a fixture
    // that ran out mid-test should fail on the assertion the test cares about,
    // not on an opaque undefined.
    const index = Math.min(Math.max(request.attempt, 1) - 1, scenario.responses.length - 1);

    return Promise.resolve({
      raw: scenario.responses[index],
      usage: scenario.usage ?? DEFAULT_USAGE,
      model: scenario.model ?? DEFAULT_MODEL,
    });
  }

  private scenarioFor(request: ExtractionRequest): string {
    const matched = this.resolveScenario?.(request.text);
    return matched && matched in this.library ? matched : this.defaultScenario;
  }

  private assertScenarioExists(name: string): void {
    if (!(name in this.library)) {
      const available = Object.keys(this.library).join(', ');
      throw new Error(`Unknown fixture scenario "${name}". Available: ${available}`);
    }
  }
}
