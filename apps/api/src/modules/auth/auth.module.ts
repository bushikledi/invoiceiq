import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { ApiEnv } from '@invoiceiq/config';
import { API_ENV } from '../../config/config.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService, parseDuration } from './token.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => ({
        secret: env.JWT_SECRET,
        signOptions: {
          // Seconds, via our own parser, rather than handing the raw "15m"
          // string to jsonwebtoken. It keeps one duration implementation in the
          // codebase (TokenService.accessTokenTtlSeconds reports the same
          // number to clients) so the advertised expiry cannot disagree with
          // the real one.
          expiresIn: parseDuration(env.ACCESS_TOKEN_TTL),
          algorithm: 'HS256' as const,
        },
        // Pinning the algorithm on verify too is what prevents the classic
        // `alg: none` / algorithm-confusion attack, where a forged token claims
        // a different algorithm and the library obligingly honours it.
        verifyOptions: {
          algorithms: ['HS256' as const],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService],
  // TokenService is exported so the global JwtAuthGuard can verify tokens.
  exports: [TokenService],
})
export class AuthModule {}
