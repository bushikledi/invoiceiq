import { Module } from '@nestjs/common';
import { ReviewController } from './review.controller.js';
import { ReviewService } from './review.service.js';

@Module({
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
