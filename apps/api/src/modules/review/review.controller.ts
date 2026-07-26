import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ReviewRequestSchema,
  type AuthenticatedUser,
  type DocumentDetail,
  type ReviewRequest,
  type ReviewResponse,
} from '@invoiceiq/contracts';
import { CurrentUser } from '../auth/auth.decorators.js';
import { ZodBody } from '../../common/validation/zod-validation.pipe.js';
import { ReviewService } from './review.service.js';

@Controller('documents')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  /** Everything the review screen needs, in one call. */
  @Get(':id/detail')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentDetail> {
    return this.review.detail(user.id, id);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(ReviewRequestSchema) body: ReviewRequest,
  ): Promise<ReviewResponse> {
    return this.review.submit(user.id, id, body);
  }
}
