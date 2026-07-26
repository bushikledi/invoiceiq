import base from './base.mjs';

/**
 * Next.js app. `new Date()` is legitimate in presentation code (relative
 * timestamps), so the domain-layer clock rule is relaxed here.
 */
export default [
  ...base,
  {
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
