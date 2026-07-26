import base from '@invoiceiq/config/eslint/base.mjs';

export default [
  ...base,
  {
    ignores: ['generated/**', 'prisma/migrations/**'],
  },
];
