import base from './base.mjs';

/**
 * packages/domain — the pure core. The dependency rule is enforced structurally
 * by dependency-cruiser; these rules enforce it stylistically too, so violations
 * are caught in the editor rather than only in CI.
 */
export default [
  ...base,
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@nestjs/*',
                '@prisma/*',
                'bullmq',
                'ioredis',
                '@aws-sdk/*',
                '@anthropic-ai/*',
                'openai',
                'next',
                'react',
              ],
              message:
                'packages/domain is framework-free: it may import only zod. Move this to the infrastructure layer.',
            },
          ],
        },
      ],
    },
  },
];
