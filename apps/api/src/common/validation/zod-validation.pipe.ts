import { Body, Injectable, Query, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';

/**
 * Validates a payload against a Zod schema from packages/contracts.
 *
 * One schema language across the whole system — extraction schema, DTOs, env,
 * frontend types — is a deliberate architectural decision (ADR 0004). This pipe
 * is what makes it true at the HTTP boundary.
 *
 * ZodError propagates untouched; the global exception filter already renders it
 * as a validation_error envelope with per-field paths, so duplicating that
 * mapping here would create two places for it to drift.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    return this.schema.parse(value);
  }
}

/** `@ZodBody(LoginRequestSchema) body: LoginRequest` */
export const ZodBody = <T>(schema: ZodType<T>): ParameterDecorator =>
  Body(new ZodValidationPipe(schema));

/** `@ZodQuery(ListDocumentsQuerySchema) query: ListDocumentsQuery` */
export const ZodQuery = <T>(schema: ZodType<T>): ParameterDecorator =>
  Query(new ZodValidationPipe(schema));

export { ZodError };
