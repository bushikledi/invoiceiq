import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import { DependencyHealthIndicator } from './dependency.health.js';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DependencyHealthIndicator],
})
export class HealthModule {}
