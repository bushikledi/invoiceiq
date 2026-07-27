import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * Load sanity, not a benchmark.
 *
 * The question this answers is narrow and worth answering: when fifty people
 * upload at once, does the API stay responsive, or does the queue back-pressure
 * reach the request path? Those are very different systems. The first degrades
 * gracefully — uploads are accepted, extraction takes longer. The second is an
 * outage, because a slow LLM has taken the login page down with it.
 *
 * It is deliberately not a throughput benchmark. Throughput here is set by
 * EXTRACTION_RATE_LIMIT_PER_MINUTE and the provider, both of which are
 * configuration; measuring them would produce an impressive number that means
 * nothing. What matters is the *decoupling*.
 *
 * Run against a local stack:
 *
 *   k6 run -e API_URL=http://localhost:3001 \
 *          -e EMAIL=demo@invoiceiq.dev -e PASSWORD=demo-password-123 \
 *          infra/load/upload-burst.js
 *
 * Or without installing k6 (note the host alias -- a container cannot reach
 * `localhost`, and `--network host` is a no-op on Docker Desktop):
 *
 *   docker run --rm -i -v "$PWD/infra/load:/scripts" grafana/k6 run \
 *     -e API_URL=http://host.docker.internal:3001 /scripts/upload-burst.js
 *
 * Do not point it at production. It creates real documents.
 *
 * ## Raise the rate limit for the run, or you will measure the rate limiter
 *
 * Throttling is per IP, and every VU here shares one. At the shipped default
 * (100/minute) fifty uploads plus five pollers is roughly 450 requests a minute
 * from a single address, so most of them are correctly refused — and the run
 * reports 88% "failure" that is entirely the limiter working as designed. That
 * is a true fact about the limiter and tells you nothing about whether queue
 * pressure reaches the request path, which is the question.
 *
 * So restart the API with the ceiling lifted first:
 *
 *   RATE_LIMIT_GLOBAL_PER_MINUTE=100000 RATE_LIMIT_AUTH_PER_MINUTE=1000 \
 *     ./scripts/dev-stack.sh restart
 */

const API = __ENV.API_URL || 'http://localhost:3001';
const BASE = `${API}/api/v1`;
const EMAIL = __ENV.EMAIL || 'demo@invoiceiq.dev';
const PASSWORD = __ENV.PASSWORD || 'demo-password-123';

const uploadsStarted = new Counter('uploads_started');
const uploadsAccepted = new Counter('uploads_accepted');
const rateLimited = new Counter('rate_limited');
const readLatency = new Trend('read_latency_ms');
const readSuccess = new Rate('read_success');

export const options = {
  scenarios: {
    // The burst: fifty uploads arriving at once.
    uploads: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 1,
      exec: 'upload',
      maxDuration: '2m',
    },
    // Concurrently, a reader doing what a person on the dashboard does. This
    // scenario is the actual assertion — the uploads are only the load that
    // makes it meaningful.
    readers: {
      executor: 'constant-vus',
      vus: 5,
      duration: '60s',
      exec: 'read',
      startTime: '0s',
    },
  },
  thresholds: {
    // The point of the whole exercise: reads stay fast while the queue fills.
    read_latency_ms: ['p(95)<500'],
    read_success: ['rate>0.98'],
    // Uploads may be throttled — that is the rate limiter working, not a
    // failure — but they must not error out.
    'http_req_failed{scenario:uploads}': ['rate<0.05'],
  },
};

/**
 * Logs in exactly once, before any VU starts, and hands the token to all of them.
 *
 * The first version of this script logged in per iteration, which meant 55 VUs
 * racing the auth limiter (10/minute, and deliberately tight -- login is the
 * route worth brute-forcing). Forty-two of fifty uploads never got past the
 * front door, and the run reported that as an upload failure. It was not: it
 * was the load generator hammering a limiter that exists precisely to stop
 * that, while a real client logs in once and reuses the token.
 *
 * A load test whose own behaviour dominates the result measures the load test.
 */
export function setup() {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } },
  );

  if (res.status !== 200) {
    // A throw in setup aborts the run cleanly, before any VU spins. Throwing
    // inside an iteration would not: k6 restarts the iteration immediately, so
    // an unreachable API becomes a 28,000-per-second spin reporting a hundred
    // percent failure rate that looks exactly like a load-test finding.
    throw new Error(`Login failed (${res.status}) against ${BASE}. Is the stack up and seeded?`);
  }

  return { token: res.json('accessToken') };
}

/**
 * A minimal valid PDF, built in memory.
 *
 * Generated rather than read from disk, and made unique per VU, because the
 * server deduplicates identical bytes — fifty copies of one file would produce
 * one extraction and forty-nine no-ops, which is not the load being tested.
 */
function makePdf(seed) {
  const marker = `InvoiceIQ load ${seed} ${Date.now()}`;
  return (
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
    `% ${marker}\n` +
    'trailer<</Root 1 0 R>>\n%%EOF\n'
  );
}

export function upload(data) {
  const auth = {
    Authorization: `Bearer ${data.token}`,
    'Content-Type': 'application/json',
  };
  const body = makePdf(__VU);

  uploadsStarted.add(1);

  const presign = http.post(
    `${BASE}/documents/uploads`,
    JSON.stringify({
      filename: `load-${__VU}.pdf`,
      sizeBytes: body.length,
      contentType: 'application/pdf',
    }),
    { headers: auth, tags: { name: 'presign' } },
  );

  if (presign.status === 429) {
    rateLimited.add(1);
    return;
  }

  if (!check(presign, { 'presign accepted': (r) => r.status === 201 })) return;

  const put = http.put(presign.json('uploadUrl'), body, {
    headers: { 'Content-Type': 'application/pdf' },
    tags: { name: 's3_put' },
  });

  if (!check(put, { stored: (r) => r.status === 200 })) return;

  const complete = http.post(`${BASE}/documents/${presign.json('documentId')}/complete`, null, {
    headers: auth,
    tags: { name: 'complete' },
  });

  if (complete.status === 429) {
    rateLimited.add(1);
    return;
  }

  if (check(complete, { queued: (r) => r.status === 200 })) uploadsAccepted.add(1);
}

export function read(data) {
  const headers = { Authorization: `Bearer ${data.token}` };

  const res = http.get(`${BASE}/documents?limit=20`, { headers, tags: { name: 'list' } });

  readLatency.add(res.timings.duration);
  // A 429 counts as a failure here on purpose: throttling the *reader* is the
  // dashboard going down, which is exactly the outcome being tested for.
  readSuccess.add(res.status === 200);

  sleep(1);
}
