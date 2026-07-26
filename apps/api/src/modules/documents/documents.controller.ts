import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  CreateUploadRequestSchema,
  ListDocumentsQuerySchema,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type DocumentFileResponse,
  type DocumentSummary,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
} from '@invoiceiq/contracts';
import type { AuthenticatedUser } from '@invoiceiq/contracts';
import { CurrentUser } from '../auth/auth.decorators.js';
import { ZodBody, ZodQuery } from '../../common/validation/zod-validation.pipe.js';
import { DocumentsService } from './documents.service.js';

/**
 * Documents.
 *
 * Protected by the global JwtAuthGuard — there is no @Public() here, so every
 * route requires a bearer token. Every handler passes the caller's id down to
 * the service, which scopes each query by owner.
 */
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Step 1 of the upload dance: reserve a row, return a presigned PUT. */
  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  createUpload(
    @CurrentUser() user: AuthenticatedUser,
    @ZodBody(CreateUploadRequestSchema) body: CreateUploadRequest,
  ): Promise<CreateUploadResponse> {
    return this.documents.createUpload(user.id, body);
  }

  /** Step 3: the client confirms; the server verifies and queues. */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  completeUpload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentSummary> {
    return this.documents.completeUpload(user.id, id);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @ZodQuery(ListDocumentsQuerySchema) query: ListDocumentsQuery,
  ): Promise<ListDocumentsResponse> {
    return this.documents.list(user.id, query);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentSummary> {
    return this.documents.get(user.id, id);
  }

  /** Presigned GET for the PDF viewer, valid for a few minutes. */
  @Get(':id/file')
  file(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DocumentFileResponse> {
    return this.documents.fileUrl(user.id, id);
  }
}
