import next from '@invoiceiq/config/eslint/next.mjs';

export default [
  ...next,
  {
    // Build output and Next's generated ambient types are not ours to lint.
    ignores: ['.next/**', 'next-env.d.ts', 'next.config.ts', 'postcss.config.mjs'],
  },
];
