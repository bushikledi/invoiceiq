/**
 * Display formatting.
 *
 * Money arrives as integer minor units, which is the only representation that
 * survives arithmetic intact. Converting to a decimal happens here, at the last
 * possible moment, and only for human eyes — never before a comparison.
 */

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    // An unrecognised currency code (which CURRENCY_KNOWN warns about rather
    // than rejecting) must not crash the screen showing the warning.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(date);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const seconds = Math.round((then - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let value = seconds;
  for (const [unit, size] of units) {
    if (Math.abs(value) < size) {
      return new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' }).format(
        Math.round(value),
        unit,
      );
    }
    value /= size;
  }
  return formatDate(iso);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Sub-cent costs are the norm here, so the usual 2dp would show every row as $0.00. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export const formatPercent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/** Turns `lineItems[0].totalCents` into "Line 1 · Total" for a findings banner. */
export function humanizePath(path: string): string {
  const lineItem = /^lineItems\[(\d+)\]\.(.+)$/.exec(path);
  if (lineItem) {
    return `Line ${Number(lineItem[1]) + 1} · ${humanizeField(lineItem[2]!)}`;
  }
  return path.split('.').map(humanizeField).join(' · ');
}

function humanizeField(field: string): string {
  const withoutUnit = field.replace(/Cents$/, '').replace(/Percent$/, '');
  const spaced = withoutUnit.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
