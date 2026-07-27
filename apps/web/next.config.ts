import type { NextConfig } from 'next';

/**
 * Content Security Policy.
 *
 * The app renders untrusted content — vendor names, addresses and line-item
 * descriptions lifted verbatim from PDFs an attacker may have authored. React
 * escapes them, so a CSP is not the primary defence; it is the layer that
 * decides how bad a *lapse* in the primary defence gets to be. Without it, one
 * `dangerouslySetInnerHTML` added in a hurry is a session compromise. With it,
 * the injected script has no origin it is allowed to talk to.
 *
 * Two honest concessions, both to Next rather than to convenience:
 *
 * `'unsafe-inline'` for styles: Next injects inline `<style>` for critical CSS
 * and the App Router exposes no nonce hook for it. Style injection is a far
 * narrower capability than script injection — the realistic attack is
 * defacement or a clickjacking overlay, and `frame-ancestors 'none'` closes the
 * latter.
 *
 * `'unsafe-inline'` for scripts: the theme script in `<head>` must run before
 * first paint to avoid a white flash, and hydration inlines bootstrap data.
 * Nonces would mean rendering every page dynamically, trading the static shell
 * for a marginal tightening — and `strict-dynamic` is not usable while the
 * inline theme script has no nonce either. Worth revisiting; not worth
 * pretending is solved.
 */
const API_ORIGIN = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

/** Object storage is a separate origin: the PDF pane loads presigned URLs from it. */
const STORAGE_ORIGIN = process.env['NEXT_PUBLIC_STORAGE_ORIGIN'] ?? 'http://localhost:9000';

/**
 * React's development build calls `eval()` — for reconstructing stack traces
 * across the server/client boundary, among other debugging features. Production
 * never does.
 *
 * So the dev policy is deliberately weaker than the shipped one. The
 * alternative is a policy that makes `next dev` unusable, which gets it deleted
 * rather than fixed; this way the strict policy is the one that ships and is
 * the one CI checks.
 */
const isDev = process.env.NODE_ENV === 'development';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The API for XHR and the SSE stream; storage for the presigned PDF fetch.
  `connect-src 'self' ${API_ORIGIN} ${STORAGE_ORIGIN}`,
  // The review screen embeds the PDF from object storage in an <object>.
  `object-src 'self' ${STORAGE_ORIGIN}`,
  `frame-src 'self' ${STORAGE_ORIGIN}`,
  "base-uri 'self'",
  // No form is posted anywhere: login submits through fetch. Restricting the
  // action closes the "injected form exfiltrates the password field" route.
  "form-action 'self'",
  // Clickjacking. The reviewer's approve button is exactly the control worth
  // framing invisibly over something else.
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  // Belt and braces with frame-ancestors, for anything predating CSP level 2.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Cross-origin requests send no path, so a presigned URL cannot leak through
  // a Referer header to object storage or anywhere else.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Nothing here needs a camera, a microphone or a location.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle with only the node_modules actually
  // reached at runtime — essential in a pnpm monorepo, where the naive copy is
  // a symlink farm the container cannot resolve.
  output: 'standalone',

  // The workspace root, so tracing follows symlinks into packages/*.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

  // Next 16 dropped the built-in `next lint` integration (and the `eslint`
  // config key with it); ESLint runs as its own CI job instead.
  typedRoutes: true,

  // X-Powered-By names the framework and its version — free reconnaissance
  // that buys nothing.
  poweredByHeader: false,

  headers: () => Promise.resolve([{ source: '/:path*', headers: securityHeaders }]),
};

export default nextConfig;
