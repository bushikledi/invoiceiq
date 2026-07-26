import base from './base.mjs';

/**
 * NestJS applications: decorator-heavy, so a few structural rules from the base
 * config would fight the framework rather than catch bugs.
 */
export default [
  ...base,
  {
    rules: {
      // Nest DI relies on parameter decorators with empty constructor bodies.
      '@typescript-eslint/no-useless-constructor': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      // Decorator metadata makes these unavoidable at framework boundaries.
      '@typescript-eslint/no-unsafe-argument': 'warn',
    },
  },
];
