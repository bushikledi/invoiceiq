import { ValidationError } from '@invoiceiq/domain';
import type { Correction } from '@invoiceiq/contracts';

/**
 * Applies field corrections addressed by dotted path.
 *
 * Paths use the same notation as findings and confidence scores
 * (`lineItems[2].totalCents`), so the three line up in the UI without any
 * translation layer.
 *
 * The implementation is deliberately restrictive. Writing to an arbitrary
 * client-supplied path is how prototype-pollution bugs happen — a correction
 * for `__proto__.isAdmin` must be rejected outright, not applied to a copy and
 * hoped about. Only paths that already exist on the extraction are writable,
 * which also means a typo'd path fails loudly instead of silently adding a
 * field nobody reads.
 */

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

interface Segment {
  key: string;
  index?: number;
}

/** Parses `lineItems[2].totalCents` into addressable segments. */
export function parsePath(path: string): Segment[] {
  if (path.trim() === '') {
    throw new ValidationError('Correction path cannot be empty', [
      { path: 'corrections', message: 'Path is required' },
    ]);
  }

  return path.split('.').map((part) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/.exec(part);

    if (!match) {
      throw new ValidationError(`Malformed correction path: "${path}"`, [
        { path, message: 'Expected segments like `totalCents` or `lineItems[2]`' },
      ]);
    }

    const key = match[1]!;
    if (FORBIDDEN_SEGMENTS.has(key)) {
      throw new ValidationError(`Refusing to write to "${key}"`, [
        { path, message: 'That path is not writable' },
      ]);
    }

    return match[2] === undefined ? { key } : { key, index: Number(match[2]) };
  });
}

/**
 * Returns a corrected copy. The input is never mutated — the caller still needs
 * the original to compare against and to store as the previous version.
 */
export function applyCorrections<T>(source: T, corrections: readonly Correction[]): T {
  // Structured clone rather than a shallow spread: line items are nested, and a
  // shallow copy would have the correction reach through into the original.
  const draft = structuredClone(source) as Record<string, unknown>;

  for (const correction of corrections) {
    applyOne(draft, parsePath(correction.path), correction.value, correction.path);
  }

  return draft as T;
}

function applyOne(
  root: Record<string, unknown>,
  segments: Segment[],
  value: unknown,
  originalPath: string,
): void {
  let cursor: unknown = root;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const isLast = i === segments.length - 1;

    if (typeof cursor !== 'object' || cursor === null) {
      throw new ValidationError(`Cannot apply correction at "${originalPath}"`, [
        { path: originalPath, message: 'Path does not exist on this extraction' },
      ]);
    }

    const container = cursor as Record<string, unknown>;

    // Only existing fields are writable. A typo'd path must fail rather than
    // quietly adding a key that nothing reads.
    if (!Object.prototype.hasOwnProperty.call(container, segment.key)) {
      throw new ValidationError(`Unknown field "${originalPath}"`, [
        { path: originalPath, message: 'No such field on this extraction' },
      ]);
    }

    if (segment.index === undefined) {
      if (isLast) {
        container[segment.key] = value;
        return;
      }
      cursor = container[segment.key];
      continue;
    }

    const array = container[segment.key];
    if (!Array.isArray(array)) {
      throw new ValidationError(`"${segment.key}" is not a list`, [
        { path: originalPath, message: 'Indexed access on a non-array field' },
      ]);
    }
    if (segment.index >= array.length) {
      throw new ValidationError(`Index out of range in "${originalPath}"`, [
        { path: originalPath, message: `This invoice has ${array.length} line item(s)` },
      ]);
    }

    if (isLast) {
      array[segment.index] = value;
      return;
    }
    cursor = array[segment.index];
  }
}
