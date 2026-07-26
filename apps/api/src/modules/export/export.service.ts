import { Injectable } from '@nestjs/common';
import { CSV_COLUMNS, type ExportQuery } from '@invoiceiq/contracts';
import { Prisma, type PrismaClient } from '@invoiceiq/database';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

/** Rows are pulled in pages so memory stays flat regardless of export size. */
const PAGE_SIZE = 200;

interface InvoiceData {
  vendor: { name: string; vatNumber: string | null };
  invoiceNumber: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  lineItems: {
    description: string;
    quantity: number;
    unitPriceCents: number;
    vatRatePercent: number;
    totalCents: number;
  }[];
  subtotalCents: number;
  vatTotalCents: number;
  totalCents: number;
}

@Injectable()
export class ExportService {
  constructor(private readonly prismaService: PrismaService) {}

  private get prisma(): PrismaClient {
    return this.prismaService.client;
  }

  /**
   * Streams an export.
   *
   * A generator rather than building a string: an export of every document is
   * unbounded, and materialising it would put the whole result set in the
   * memory of a 512 MB process before a single byte reached the client. Yielding
   * page by page keeps memory flat and starts the download immediately, which
   * also stops a proxy timing the request out while nothing is sent.
   */
  async *stream(userId: string, query: ExportQuery): AsyncGenerator<string> {
    if (query.format === 'csv') {
      yield `${CSV_COLUMNS.join(',')}\n`;
    } else {
      yield '[';
    }

    let cursor: string | undefined;
    let first = true;

    for (;;) {
      const page = await this.page(userId, query, cursor);
      if (page.length === 0) break;

      for (const row of page) {
        const data = row.extractions[0]?.data as unknown as InvoiceData | undefined;

        if (query.format === 'csv') {
          yield this.toCsvRows(row, data);
        } else {
          yield `${first ? '' : ','}\n${JSON.stringify(this.toJson(row, data), null, 2)}`;
          first = false;
        }
      }

      cursor = page[page.length - 1]?.id;
      if (page.length < PAGE_SIZE) break;
    }

    if (query.format === 'json') yield '\n]\n';
  }

  private page(userId: string, query: ExportQuery, cursor: string | undefined) {
    const where: Prisma.DocumentWhereInput = {
      uploaderId: userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              // Inclusive of the whole `to` day: a user asking for data "to the
              // 5th" means through the end of the 5th, not up to midnight.
              ...(query.to ? { lt: new Date(`${query.to}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
    };

    return this.prisma.document.findMany({
      where,
      include: { extractions: { orderBy: { version: 'desc' }, take: 1 } },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }

  /** One CSV row per line item, with document columns repeated. */
  private toCsvRows(
    document: {
      id: string;
      originalName: string;
      status: string;
      createdAt: Date;
      extractions: {
        version: number;
        model: string;
        overallConfidence: Prisma.Decimal;
        costUsd: Prisma.Decimal;
      }[];
    },
    data: InvoiceData | undefined,
  ): string {
    const base = [
      document.id,
      document.originalName,
      document.status,
      document.createdAt.toISOString(),
    ];

    // A document with no extraction still appears, so a reconciliation against
    // "everything I uploaded" is not silently short a few rows.
    if (!data) {
      return `${csvLine([...base, ...Array<string>(CSV_COLUMNS.length - base.length).fill('')])}\n`;
    }

    const invoice = [
      data.vendor.name,
      data.vendor.vatNumber ?? '',
      data.invoiceNumber,
      data.issueDate,
      data.dueDate ?? '',
      data.currency,
    ];

    const totals = [money(data.subtotalCents), money(data.vatTotalCents), money(data.totalCents)];

    // Extraction metadata is repeated on every line, like the document columns.
    // Without it the export cannot answer "which of these did the model find
    // hard, and what did they cost?" — the questions the confidence and cost
    // columns exist for.
    const extraction = document.extractions[0];
    const meta = extraction
      ? [
          extraction.overallConfidence.toString(),
          String(extraction.version),
          extraction.model,
          extraction.costUsd.toString(),
        ]
      : ['', '', '', ''];

    return data.lineItems
      .map((item, index) =>
        csvLine([
          ...base,
          ...invoice,
          String(index + 1),
          item.description,
          String(item.quantity),
          money(item.unitPriceCents),
          String(item.vatRatePercent),
          money(item.totalCents),
          ...totals,
          ...meta,
        ]),
      )
      .map((line) => `${line}\n`)
      .join('');
  }

  private toJson(
    document: { id: string; originalName: string; status: string; createdAt: Date },
    data: InvoiceData | undefined,
  ) {
    return {
      documentId: document.id,
      originalName: document.originalName,
      status: document.status,
      uploadedAt: document.createdAt.toISOString(),
      // Amounts stay in minor units here: JSON is consumed by other software,
      // which should do its own arithmetic on integers rather than re-parse a
      // formatted decimal we produced for humans.
      invoice: data ?? null,
    };
  }
}

/**
 * Escapes a CSV field.
 *
 * A leading =, +, - or @ is prefixed with a quote. Without that, a vendor named
 * `=cmd|...` is executed as a formula when the file is opened in Excel — CSV
 * injection, and a genuine attack path when the field content comes from a PDF
 * an attacker supplied.
 */
function csvField(value: string): string {
  const dangerous = /^[=+\-@\t\r]/.test(value);
  const escaped = dangerous ? `'${value}` : value;

  return /[",\n\r]/.test(escaped) ? `"${escaped.replace(/"/g, '""')}"` : escaped;
}

const csvLine = (fields: string[]): string => fields.map(csvField).join(',');

/** Minor units to a plain decimal string, for spreadsheet arithmetic. */
const money = (cents: number): string => (cents / 100).toFixed(2);
