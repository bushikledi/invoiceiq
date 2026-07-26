import { Injectable } from '@nestjs/common';
import type { DocumentStats } from '@invoiceiq/contracts';
import type { PrismaClient } from '@invoiceiq/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

@Injectable()
export class StatsService {
  constructor(private readonly prismaService: PrismaService) {}

  private get prisma(): PrismaClient {
    return this.prismaService.client;
  }

  /**
   * Headline figures for the dashboard.
   *
   * One grouped count plus one aggregate rather than eight separate queries —
   * this runs on every dashboard load, and a stat strip is not worth eight
   * round trips.
   */
  async forUser(userId: string): Promise<DocumentStats> {
    const [byStatus, cost] = await Promise.all([
      this.prisma.document.groupBy({
        by: ['status'],
        where: { uploaderId: userId },
        _count: true,
      }),
      this.prisma.extraction.aggregate({
        where: { document: { uploaderId: userId } },
        _sum: { costUsd: true },
        _count: true,
      }),
    ]);

    const count = (status: string) => byStatus.find((row) => row.status === status)?._count ?? 0;

    const total = byStatus.reduce((sum, row) => sum + row._count, 0);
    const completed = count('COMPLETED');
    const needsReview = count('NEEDS_REVIEW');
    const failed = count('FAILED');

    // Denominator is documents that produced a verdict, not everything
    // uploaded: counting failures and in-flight work against the auto-approval
    // rate would make the number drift with queue depth rather than describe
    // extraction quality.
    const decided = completed + needsReview;
    const totalCostUsd = Number(cost._sum.costUsd ?? 0);

    return {
      total,
      completed,
      needsReview,
      failed,
      processing: total - completed - needsReview - failed,
      autoApprovedRatio: decided === 0 ? 0 : completed / decided,
      totalCostUsd,
      averageCostUsd: cost._count === 0 ? 0 : totalCostUsd / cost._count,
    };
  }
}
