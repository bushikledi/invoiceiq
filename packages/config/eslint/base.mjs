import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Base flat config shared by every workspace package.
 * Type-aware linting is on: it is what makes the `no-floating-promises` rule
 * (critical in a queue/worker codebase) actually work.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', '.next/**', '.turbo/**', 'coverage/**', 'generated/**', '*.config.*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Money is integer cents everywhere; a stray float is a correctness bug.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Do not call new Date() directly — inject a Clock so business rules stay testable.',
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Integration tests assert against HTTP response bodies, which supertest
    // types as `any` because JSON genuinely is untyped at the wire. Enforcing
    // strict-any rules here would mean casting every assertion for no safety
    // gain — the assertion *is* the check. These rules stay on in src/, where
    // an implicit `any` really can hide a bug.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**', '**/e2e/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  prettier,
);
