import { Global, Module } from '@nestjs/common';
import { loadApiEnv, type ApiEnv } from '@invoiceiq/config';

/** DI token for the validated environment. */
export const API_ENV = Symbol('API_ENV');

/**
 * Environment is parsed exactly once, here, at module construction. If anything
 * is missing or malformed the process fails to boot rather than surfacing the
 * problem on some later request path.
 *
 * Global because nearly every module needs a slice of it, and threading a
 * ConfigModule import through all of them is noise.
 */
@Global()
@Module({
  providers: [
    {
      provide: API_ENV,
      useFactory: (): ApiEnv => loadApiEnv(process.env),
    },
  ],
  exports: [API_ENV],
})
export class ApiConfigModule {}
