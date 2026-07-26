import nest from '@invoiceiq/config/eslint/nest.mjs';

export default [
  ...nest,
  {
    ignores: ['dist/**', 'eslint.config.mjs', '*.config.ts'],
  },
];
