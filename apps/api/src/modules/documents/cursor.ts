import { ValidationError } from '@invoiceiq/domain';

/**
 * Cursor pagination over (created_at, id).
 *
 * Offset pagination is wrong for a feed that changes while you read it: a
 * document completing between page 1 and page 2 shifts every subsequent row,
 * so the reader silently skips or repeats items. A cursor anchored to the last
 * row read is stable regardless of what happens elsewhere in the table.
 *
 * `id` is the tiebreaker because `created_at` is not unique — two documents
 * uploaded in the same millisecond would otherwise make the ordering
 * non-deterministic and the cursor lossy.
 *
 * The encoding is opaque on purpose. Clients that parse it start depending on
 * the sort key, which then cannot change without breaking them.
 */
export interface DocumentCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor({ createdAt, id }: DocumentCursor): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): DocumentCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new ValidationError('Malformed cursor', [
      { path: 'cursor', message: 'Not valid base64' },
    ]);
  }

  const separator = decoded.lastIndexOf('|');
  if (separator === -1) {
    throw new ValidationError('Malformed cursor', [
      { path: 'cursor', message: 'Expected "<timestamp>|<id>"' },
    ]);
  }

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new ValidationError('Malformed cursor', [
      { path: 'cursor', message: 'Cursor does not describe a valid position' },
    ]);
  }

  return { createdAt, id };
}
