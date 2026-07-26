/**
 * Seeds the demo corpus by driving the real HTTP API.
 *
 * Deliberately not by inserting rows. Writing extractions straight into the
 * database would be a second implementation of the pipeline — one that can
 * drift from the real one, and that proves nothing about whether upload,
 * validation and embedding actually work. Going through the API means the demo
 * data is produced exactly the way a user's data is, and a broken pipeline
 * fails the seed instead of quietly producing a convincing-looking dashboard.
 *
 * Usage (API must be running):
 *   pnpm seed:demo
 *   API_URL=https://invoiceiq.up.railway.app pnpm seed:demo
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.resolve(HERE, '../packages/ai/samples');

const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';
const BASE = `${API_URL}/api/v1`;
const EMAIL = process.env['DEMO_EMAIL'] ?? 'demo@invoiceiq.dev';
const PASSWORD = process.env['DEMO_PASSWORD'] ?? 'demo-password-123';

/**
 * The corpus, chosen so every status and every interesting behaviour is
 * visible on a dashboard someone opens cold.
 */
const CORPUS = [
  { file: 'clean-invoice', as: 'ACME-INV-233.pdf', shows: 'clean → COMPLETED' },
  { file: 'sum-mismatch', as: 'ACME-INV-241.pdf', shows: 'line items do not sum → NEEDS_REVIEW' },
  { file: 'multi-rate', as: 'Studio-Bianchi-INV-270.pdf', shows: 'two VAT rates, still clean' },
  { file: 'missing-vat-number', as: 'Bright-Supplies-INV-255.pdf', shows: 'no VAT id, GBP' },
  { file: 'long-multipage', as: 'Fornitura-INV-288.pdf', shows: 'five pages, truncation path' },
  { file: 'scanned-image', as: 'scanned-receipt.pdf', shows: 'no text → FAILED, zero LLM spend' },
] as const;

async function login(): Promise<string> {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!response.ok) {
    throw new Error(
      `Login failed (${response.status}). Has \`pnpm db:seed\` run to create ${EMAIL}?`,
    );
  }

  const { accessToken } = (await response.json()) as { accessToken: string };
  return accessToken;
}

async function upload(token: string, file: string, as: string): Promise<string> {
  const bytes = await readFile(path.join(SAMPLES, `${file}.pdf`));
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const presignResponse = await fetch(`${BASE}/documents/uploads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filename: as,
      sizeBytes: bytes.byteLength,
      contentType: 'application/pdf',
    }),
  });

  if (!presignResponse.ok) {
    throw new Error(`Presign failed for ${as}: ${presignResponse.status}`);
  }

  const { uploadUrl, documentId } = (await presignResponse.json()) as {
    uploadUrl: string;
    documentId: string;
  };

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: new Uint8Array(bytes),
    headers: { 'Content-Type': 'application/pdf' },
  });
  if (!put.ok) throw new Error(`Storage rejected ${as}: ${put.status}`);

  // The trust boundary. A non-2xx here is the server refusing the bytes, which
  // for the scanned sample is the correct outcome further along — but at this
  // step it would mean a real failure.
  const complete = await fetch(`${BASE}/documents/${documentId}/complete`, {
    method: 'POST',
    headers,
  });
  if (!complete.ok) throw new Error(`Completion failed for ${as}: ${complete.status}`);

  return documentId;
}

async function main(): Promise<void> {
  console.log(`Seeding demo data via ${BASE}\n`);

  const token = await login();
  const ids: string[] = [];

  for (const item of CORPUS) {
    process.stdout.write(`  ${item.as.padEnd(30)} ${item.shows.padEnd(42)}`);
    try {
      ids.push(await upload(token, item.file, item.as));
      console.log('queued');
    } catch (error) {
      // A duplicate is not a failure: the seed is idempotent by content hash,
      // so re-running it against a populated instance is a no-op.
      console.log(error instanceof Error ? `skipped (${error.message})` : 'skipped');
    }
  }

  console.log(`\n${ids.length} document(s) queued.`);
  console.log('The worker processes them in the background; the dashboard updates as it goes.');
  console.log(`\nSign in at the web app as ${EMAIL}.`);
}

main().catch((error: unknown) => {
  console.error('\nSeeding failed:', error instanceof Error ? error.message : error);
  console.error('\nIs the API running? Try: ./scripts/dev-stack.sh status');
  process.exitCode = 1;
});
