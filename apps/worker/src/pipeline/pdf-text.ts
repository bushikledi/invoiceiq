import { extractText, getDocumentProxy } from 'unpdf';

/**
 * PDF → text.
 *
 * Below this many characters per page, we treat the document as a scan and
 * refuse it. The threshold is deliberately generous: a real invoice page has
 * hundreds of characters, while an image-only page yields a handful of stray
 * marks at most. Anything in between is ambiguous enough that a human should
 * look at it rather than us paying to have a model guess.
 */
export const MIN_CHARS_PER_PAGE = 50;

export interface PdfText {
  readonly text: string;
  readonly pageCount: number;
  /** Per-page text, so truncation can keep whole pages rather than cutting mid-table. */
  readonly pages: readonly string[];
}

export class ScannedDocumentError extends Error {
  readonly reason = 'LIKELY_SCANNED_IMAGE' as const;

  constructor(
    readonly charsPerPage: number,
    readonly pageCount: number,
  ) {
    super(
      `Document yielded ${charsPerPage.toFixed(0)} characters per page across ${pageCount} page(s), ` +
        'which indicates a scanned image rather than a text PDF. OCR is out of scope.',
    );
    this.name = 'ScannedDocumentError';
    Object.setPrototypeOf(this, ScannedDocumentError.prototype);
  }
}

export class UnreadablePdfError extends Error {
  readonly reason = 'UNREADABLE_PDF' as const;

  constructor(cause: unknown) {
    super(
      `The file could not be parsed as a PDF: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'UnreadablePdfError';
    Object.setPrototypeOf(this, UnreadablePdfError.prototype);
  }
}

/**
 * Extracts text, rejecting anything the LLM could not usefully read.
 *
 * This early rejection is the first line of cost control: a scanned invoice
 * would otherwise be sent to the model, which would dutifully hallucinate an
 * entire invoice from nothing and charge us for the privilege. Catching it here
 * costs one PDF parse and zero tokens.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  let pages: string[];

  try {
    const pdf = await getDocumentProxy(bytes);
    const result = await extractText(pdf, { mergePages: false });
    pages = result.text;
  } catch (error) {
    throw new UnreadablePdfError(error);
  }

  const pageCount = Math.max(pages.length, 1);
  const text = pages.join('\n\n');
  const charsPerPage = text.trim().length / pageCount;

  if (charsPerPage < MIN_CHARS_PER_PAGE) {
    throw new ScannedDocumentError(charsPerPage, pageCount);
  }

  return { text, pageCount, pages };
}

/**
 * Caps prompt size, keeping the first and last pages.
 *
 * Invoices put the header (vendor, number, dates) at the front and the totals
 * at the back — which are exactly the fields that matter most. A naive head
 * truncation would discard the totals, the single worst thing to lose.
 *
 * Roughly four characters per token is the usual English/Italian
 * approximation. It does not need to be exact: it is a spend guard, not an
 * accounting figure, and the real token count is recorded from the API
 * response afterwards.
 */
export const CHARS_PER_TOKEN = 4;

export function truncateForPrompt(pdf: PdfText, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  if (pdf.text.length <= maxChars) return pdf.text;

  if (pdf.pages.length <= 2) {
    // Nothing to drop whole pages from — take the head and tail of the text.
    const half = Math.floor(maxChars / 2);
    return `${pdf.text.slice(0, half)}\n\n[… truncated …]\n\n${pdf.text.slice(-half)}`;
  }

  const first = pdf.pages[0] ?? '';
  const last = pdf.pages[pdf.pages.length - 1] ?? '';
  const notice = '\n\n[… middle pages omitted …]\n\n';

  const budget = maxChars - notice.length;
  const head = first.slice(0, Math.floor(budget / 2));
  const tail = last.slice(-Math.floor(budget / 2));

  return `${head}${notice}${tail}`;
}
