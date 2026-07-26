/**
 * Records real LLM responses against the sample PDFs.
 *
 * The fixtures committed in src/fixtures are currently hand-authored, because
 * this environment has no API key. This script replaces them with genuine
 * recorded output — same shapes, real values, real token counts.
 *
 * The point of recording rather than mocking: a mock encodes what we *think*
 * the model does, and stays wrong forever. A recording is what it actually did,
 * and refreshing it is how provider drift becomes visible. CI runs against the
 * recordings so it is fast and free; the nightly contract job runs against the
 * live API so drift is caught deliberately rather than during a demo.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @invoiceiq/ai record:fixtures
 *
 * Review the diff before committing. A fixture change is a change to what every
 * downstream test believes, so it deserves the same scrutiny as source.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText, getDocumentProxy } from 'unpdf';
import { AnthropicLlmExtractor } from '../src/adapters/anthropic-extractor.js';
import { invoiceJsonSchema } from '../src/schema.js';
import { PROMPT_VERSION } from '../src/prompts/extract-invoice.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(HERE, '../samples');
const OUTPUT = path.resolve(HERE, '../src/fixtures/recorded.json');

const apiKey = process.env['ANTHROPIC_API_KEY'];
const model = process.env['LLM_MODEL'] ?? 'claude-haiku-4-5-20251001';

if (!apiKey) {
  console.error(
    'ANTHROPIC_API_KEY is not set.\n\n' +
      'This script calls the real Anthropic API and costs real money (roughly\n' +
      '$0.02 for the full sample set). Set the key and re-run:\n\n' +
      '  ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @invoiceiq/ai record:fixtures\n',
  );
  process.exit(1);
}

async function pdfText(file: string): Promise<string> {
  const bytes = await readFile(file);
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function main(): Promise<void> {
  const extractor = new AnthropicLlmExtractor({ apiKey: apiKey!, model });
  const schema = invoiceJsonSchema();

  const files = (await readdir(SAMPLES_DIR)).filter((f) => f.endsWith('.pdf')).sort();
  const recorded: Record<string, unknown> = {};

  let totalInput = 0;
  let totalOutput = 0;

  for (const file of files) {
    const slug = path.basename(file, '.pdf');
    const text = await pdfText(path.join(SAMPLES_DIR, file));

    // The scanned sample never reaches the model in production either — it is
    // rejected on text length — so recording it would only spend money to
    // capture whatever the model invents from nothing.
    if (text.trim().length < 50) {
      console.log(`  ${slug.padEnd(24)} skipped (no extractable text)`);
      continue;
    }

    process.stdout.write(`  ${slug.padEnd(24)} calling ${model}… `);

    const response = await extractor.extract({ text, schema });

    totalInput += response.usage.inputTokens;
    totalOutput += response.usage.outputTokens;

    recorded[slug] = {
      responses: [response.raw],
      model: response.model,
      usage: response.usage,
    };

    console.log(`${response.usage.inputTokens} in / ${response.usage.outputTokens} out`);
  }

  await writeFile(
    OUTPUT,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        model,
        promptVersion: PROMPT_VERSION,
        scenarios: recorded,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\nWrote ${Object.keys(recorded).length} scenarios to ${path.relative(process.cwd(), OUTPUT)}`,
  );
  console.log(`Total usage: ${totalInput} input / ${totalOutput} output tokens`);
  console.log('\nReview the diff before committing — every downstream test believes these values.');
}

main().catch((error: unknown) => {
  console.error('\nRecording failed:', error);
  process.exitCode = 1;
});
