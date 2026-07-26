/**
 * The only package that knows SQL.
 *
 * Prisma model types are re-exported so consumers never import from the
 * generated directory directly — that indirection is what lets the ORM be
 * swapped without touching call sites (see docs/adr/0003-orm.md).
 *
 * Repositories map Prisma rows to domain entities; raw Prisma rows must not
 * escape this package.
 */
export { createPrismaClient } from './client.js';
export type { PrismaClientOptions } from './client.js';

export {
  Prisma,
  PrismaClient,
  UserRole,
  DocumentStatus,
  FindingSeverity,
  ReviewAction,
} from '../generated/client/index.js';

export type {
  User,
  RefreshToken,
  Document,
  DocumentEvent,
  Extraction,
  ValidationFinding,
  ReviewDecision,
  DocumentChunk,
} from '../generated/client/index.js';
