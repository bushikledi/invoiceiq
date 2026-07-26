import type { NextConfig } from 'next';

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
};

export default nextConfig;
