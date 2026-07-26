import { Controller, Get, Res } from '@nestjs/common';
import { ExportQuerySchema, type AuthenticatedUser, type ExportQuery } from '@invoiceiq/contracts';
import type { Response } from 'express';
import { systemClock } from '@invoiceiq/domain';
import { CurrentUser } from '../auth/auth.decorators.js';
import { ZodQuery } from '../../common/validation/zod-validation.pipe.js';
import { ExportService } from './export.service.js';

@Controller('export')
export class ExportController {
  constructor(private readonly exporter: ExportService) {}

  /**
   * Streams the export straight to the response.
   *
   * `@Res()` without passthrough, because Nest's normal return-a-value path
   * buffers the whole body. The point of this endpoint is that it does not.
   */
  @Get()
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @ZodQuery(ExportQuerySchema) query: ExportQuery,
    @Res() res: Response,
  ): Promise<void> {
    const stamp = systemClock.now().toISOString().slice(0, 10);
    const filename = `invoiceiq-export-${stamp}.${query.format}`;

    res.setHeader(
      'Content-Type',
      query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    try {
      for await (const chunk of this.exporter.stream(user.id, query)) {
        // Respect backpressure: without awaiting drain, a slow client makes the
        // process buffer the entire export in memory anyway.
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (error) {
      // Headers are already sent, so the error envelope cannot be used. Ending
      // the response truncates the download, which is at least detectable —
      // the alternative is a hung request.
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
