/**
 * Corroboration: does the extracted value actually appear in the source
 * document?
 *
 * This is the cheapest hallucination detector available. An LLM asked for a
 * total it cannot find will often invent a plausible one and report high
 * confidence in it — self-reported confidence is uncalibrated precisely where
 * it matters most. But an invented number is very unlikely to appear literally
 * in the PDF text, and checking that costs zero extra tokens and no latency.
 *
 * The difficulty is that invoices write the same amount many ways:
 *   €1.240,50   1 240,50 EUR   1,240.50   1240.50
 * so a naive substring search fails constantly. Instead we tokenise every
 * number in the source into integer minor units once, and ask whether the
 * extracted amount is in that set.
 */

/**
 * Matches one printed number.
 *
 * The structure is deliberate rather than a loose character class. An earlier
 * version allowed `\s` inside the token, which meant two column-aligned amounts
 *
 *     Sedie ufficio     4 x 245,00     980,00
 *
 * merged into the single number 24500980 \u2014 and since invoices are almost
 * entirely columns of numbers, corroboration silently failed on nearly every
 * real document while still passing a naive test.
 *
 * So a separator is only accepted where a thousands group genuinely belongs:
 * followed by exactly three digits. A space is allowed there (French prints
 * "1 240,50") but can never span a column gap or a line break.
 *
 *   alternative 1: grouped thousands, optional decimals   1.240,50  1 240,50
 *   alternative 2: plain digits with optional decimals    980,00    151280
 */
const NUMBER_TOKEN = /\d{1,3}(?:[.,\u00A0\u202F ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;

/**
 * Converts a printed number to integer minor units.
 *
 * The ambiguity is `1.240` — €1,240 in Italian notation, €1.24 in English. The
 * rule used here: a separator followed by exactly two digits at the end of the
 * token is a decimal separator; anything else is a thousands separator. That
 * resolves `1.240,50` and `1,240.50` identically and correctly, and treats a
 * bare `1.240` as one thousand two hundred and forty, which is the right call
 * for European invoices.
 */
export function parseAmountToCents(token: string): number | null {
  const cleaned = token.replace(/[\s\u00A0\u202F]/g, '');
  if (cleaned === '' || !/\d/.test(cleaned)) return null;

  const lastSeparator = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));

  let integerPart: string;
  let fractionPart: string;

  if (lastSeparator === -1) {
    integerPart = cleaned;
    fractionPart = '00';
  } else {
    const tail = cleaned.slice(lastSeparator + 1);
    if (tail.length === 2 && /^\d{2}$/.test(tail)) {
      integerPart = cleaned.slice(0, lastSeparator);
      fractionPart = tail;
    } else {
      // Not a decimal separator — the whole token is an integer amount.
      integerPart = cleaned;
      fractionPart = '00';
    }
  }

  const digits = integerPart.replace(/[.,]/g, '');
  if (digits === '' || !/^\d+$/.test(digits)) return null;

  const cents = Number(digits) * 100 + Number(fractionPart);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Every monetary amount that appears in the text, as integer minor units. */
export function extractAmounts(sourceText: string): Set<number> {
  const amounts = new Set<number>();

  for (const match of sourceText.matchAll(NUMBER_TOKEN)) {
    const cents = parseAmountToCents(match[0]);
    if (cents !== null) {
      amounts.add(cents);
      // A number printed without decimals ("1240") may be the major-unit form
      // of the same amount, so record both readings rather than guessing.
      if (cents % 100 === 0) amounts.add(cents / 100);
    }
  }

  return amounts;
}

/** Normalises text for tolerant string comparison. */
export function normalizeText(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      // Strip diacritics so "Società" matches "Societa".
      .replace(/[\u0300-\u036F]/g, '')
      .replace(/[\s\u00A0\u202F]+/g, ' ')
      .trim()
  );
}

/** True when the amount appears somewhere in the document. */
export function corroboratesAmount(cents: number, amounts: ReadonlySet<number>): boolean {
  return amounts.has(cents) || amounts.has(Math.abs(cents));
}

/** True when the string appears in the document, ignoring case and accents. */
export function corroboratesString(value: string, normalizedSource: string): boolean {
  const needle = normalizeText(value);
  if (needle.length === 0) return false;
  return normalizedSource.includes(needle);
}

/**
 * True when the date appears in any common printed form.
 *
 * Invoices write dates as 2026-03-12, 12/03/2026, 12.03.2026, 12-03-2026 and
 * more; requiring the ISO form we normalised to would fail almost every real
 * document.
 */
export function corroboratesDate(isoDate: string, normalizedSource: string): boolean {
  const [year, month, day] = isoDate.split('-');
  if (!year || !month || !day) return false;

  const shortYear = year.slice(2);
  const dayNoPad = String(Number(day));
  const monthNoPad = String(Number(month));

  const candidates = [
    isoDate,
    `${day}/${month}/${year}`,
    `${day}.${month}.${year}`,
    `${day}-${month}-${year}`,
    `${month}/${day}/${year}`,
    `${day}/${month}/${shortYear}`,
    `${dayNoPad}/${monthNoPad}/${year}`,
    `${dayNoPad}.${monthNoPad}.${year}`,
    `${year}/${month}/${day}`,
  ];

  return candidates.some((candidate) => normalizedSource.includes(candidate));
}

/** Pre-computed view of the source document, built once per extraction. */
export interface SourceIndex {
  readonly normalizedText: string;
  readonly amounts: ReadonlySet<number>;
  readonly isEmpty: boolean;
}

export function buildSourceIndex(sourceText: string): SourceIndex {
  return {
    normalizedText: normalizeText(sourceText),
    amounts: extractAmounts(sourceText),
    isEmpty: sourceText.trim().length === 0,
  };
}
