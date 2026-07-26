/**
 * Generates the sample invoice PDFs used by tests, the demo seed, and the
 * nightly contract job.
 *
 * A script rather than committed binaries: the PDFs are regenerable, the diff
 * is reviewable, and — the reason that actually matters — the amounts can be
 * kept in lockstep with the fixtures and the business-rule tests. A committed
 * binary whose numbers quietly disagree with `sum-mismatch` would make the
 * whole fixture suite meaningless.
 *
 * Run: pnpm --filter @invoiceiq/ai generate:samples
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(HERE, '../samples');

interface SampleLine {
  description: string;
  quantity: number;
  unitPrice: string;
  total: string;
}

interface SampleInvoice {
  /** File name, and the scenario it corresponds to in the fixture library. */
  slug: string;
  vendor: string;
  vendorAddress: string;
  vatNumber: string | null;
  number: string;
  issueDate: string;
  dueDate: string | null;
  currencySymbol: string;
  lines: SampleLine[];
  subtotal: string;
  vat: string;
  vatRateLabel: string;
  total: string;
  /** Extra pages of filler, to exercise the multi-page truncation path. */
  fillerPages?: number;
  /** Renders as an image-only page, so text extraction yields nothing. */
  scanned?: boolean;
}

const SAMPLES: SampleInvoice[] = [
  {
    slug: 'clean-invoice',
    vendor: 'ACME S.r.l.',
    vendorAddress: 'Via Roma 1, 20121 Milano MI',
    vatNumber: 'IT12345678901',
    number: 'INV-233',
    issueDate: '12/03/2026',
    dueDate: '11/04/2026',
    currencySymbol: '€',
    lines: [
      {
        description: 'Sedie ufficio ergonomiche',
        quantity: 4,
        unitPrice: '245,00',
        total: '980,00',
      },
      {
        description: 'Scrivania regolabile in altezza',
        quantity: 1,
        unitPrice: '260,00',
        total: '260,00',
      },
    ],
    subtotal: '1.240,00',
    vat: '272,80',
    vatRateLabel: 'IVA 22%',
    total: '1.512,80',
  },
  {
    // Lines sum to 1.240,00 but the subtotal claims 1.250,00 — the €10
    // discrepancy the demo walks through.
    slug: 'sum-mismatch',
    vendor: 'ACME S.r.l.',
    vendorAddress: 'Via Roma 1, 20121 Milano MI',
    vatNumber: 'IT12345678901',
    number: 'INV-241',
    issueDate: '18/03/2026',
    dueDate: '17/04/2026',
    currencySymbol: '€',
    lines: [
      {
        description: 'Sedie ufficio ergonomiche',
        quantity: 4,
        unitPrice: '245,00',
        total: '980,00',
      },
      {
        description: 'Scrivania regolabile in altezza',
        quantity: 1,
        unitPrice: '260,00',
        total: '260,00',
      },
    ],
    subtotal: '1.250,00',
    vat: '275,00',
    vatRateLabel: 'IVA 22%',
    total: '1.525,00',
  },
  {
    slug: 'missing-vat-number',
    vendor: 'Bright Supplies Ltd',
    vendorAddress: '14 King Street, London EC2V 8AU',
    vatNumber: null,
    number: 'INV-255',
    issueDate: '02/04/2026',
    dueDate: null,
    currencySymbol: '£',
    lines: [
      { description: 'Standing desk converter', quantity: 2, unitPrice: '145.00', total: '290.00' },
    ],
    subtotal: '290.00',
    vat: '58.00',
    vatRateLabel: 'VAT 20%',
    total: '348.00',
  },
  {
    slug: 'multi-rate',
    vendor: 'Studio Bianchi S.n.c.',
    vendorAddress: 'Corso Buenos Aires 44, 20124 Milano MI',
    vatNumber: 'IT98765432109',
    number: 'INV-270',
    issueDate: '20/04/2026',
    dueDate: '20/05/2026',
    currencySymbol: '€',
    lines: [
      { description: 'Consulenza tecnica', quantity: 10, unitPrice: '100,00', total: '1.000,00' },
      { description: 'Materiale didattico', quantity: 1, unitPrice: '500,00', total: '500,00' },
    ],
    subtotal: '1.500,00',
    vat: '270,00',
    vatRateLabel: 'IVA 22% / 10%',
    total: '1.770,00',
  },
  {
    // Exercises the token cap and the first-and-last-pages truncation.
    slug: 'long-multipage',
    vendor: 'Fornitura Generale S.p.A.',
    vendorAddress: 'Viale Certosa 210, 20156 Milano MI',
    vatNumber: 'IT11223344556',
    number: 'INV-288',
    issueDate: '05/05/2026',
    dueDate: '04/06/2026',
    currencySymbol: '€',
    lines: Array.from({ length: 12 }, (_, i) => ({
      description: `Articolo di magazzino ${String(i + 1).padStart(3, '0')}`,
      quantity: 3,
      unitPrice: '25,00',
      total: '75,00',
    })),
    subtotal: '900,00',
    vat: '198,00',
    vatRateLabel: 'IVA 22%',
    total: '1.098,00',
    fillerPages: 4,
  },
  {
    // No extractable text at all — must be rejected before reaching the LLM.
    slug: 'scanned-image',
    vendor: '',
    vendorAddress: '',
    vatNumber: null,
    number: '',
    issueDate: '',
    dueDate: null,
    currencySymbol: '',
    lines: [],
    subtotal: '',
    vat: '',
    vatRateLabel: '',
    total: '',
    scanned: true,
  },
];

const MARGIN = 50;
const LINE_HEIGHT = 16;

async function render(sample: SampleInvoice): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  if (sample.scanned) {
    // A page with only vector graphics: pdf.js extracts no text from it, which
    // is exactly what LIKELY_SCANNED_IMAGE must detect.
    const page = pdf.addPage([595, 842]);
    for (let i = 0; i < 40; i++) {
      page.drawRectangle({
        x: MARGIN + (i % 8) * 60,
        y: 700 - Math.floor(i / 8) * 40,
        width: 50,
        height: 6,
        color: rgb(0.75, 0.75, 0.78),
      });
    }
    return pdf.save();
  }

  const page = pdf.addPage([595, 842]);
  let y = 792;

  const write = (text: string, options: { x?: number; size?: number; bold?: boolean } = {}) => {
    page.drawText(text, {
      x: options.x ?? MARGIN,
      y,
      size: options.size ?? 10,
      font: options.bold ? bold : regular,
      color: rgb(0.1, 0.1, 0.12),
    });
  };

  write(sample.vendor, { size: 16, bold: true });
  y -= LINE_HEIGHT * 1.4;
  write(sample.vendorAddress);
  y -= LINE_HEIGHT;

  if (sample.vatNumber) {
    write(`P.IVA ${sample.vatNumber}`);
    y -= LINE_HEIGHT;
  }

  y -= LINE_HEIGHT;
  write(`Fattura n. ${sample.number}`, { size: 12, bold: true });
  y -= LINE_HEIGHT;
  write(`Data: ${sample.issueDate}`);
  y -= LINE_HEIGHT;

  if (sample.dueDate) {
    write(`Scadenza: ${sample.dueDate}`);
    y -= LINE_HEIGHT;
  }

  y -= LINE_HEIGHT;
  write('Descrizione', { bold: true });
  write('Qta', { x: 320, bold: true });
  write('Prezzo', { x: 380, bold: true });
  write('Totale', { x: 470, bold: true });
  y -= LINE_HEIGHT * 1.2;

  for (const line of sample.lines) {
    write(line.description);
    write(String(line.quantity), { x: 320 });
    write(line.unitPrice, { x: 380 });
    write(line.total, { x: 470 });
    y -= LINE_HEIGHT;
  }

  y -= LINE_HEIGHT;
  write('Imponibile', { x: 380 });
  write(sample.subtotal, { x: 470 });
  y -= LINE_HEIGHT;
  write(sample.vatRateLabel, { x: 380 });
  write(sample.vat, { x: 470 });
  y -= LINE_HEIGHT * 1.2;
  write('TOTALE', { x: 380, bold: true, size: 12 });
  write(`${sample.currencySymbol} ${sample.total}`, { x: 470, bold: true, size: 12 });

  for (let i = 0; i < (sample.fillerPages ?? 0); i++) {
    const filler = pdf.addPage([595, 842]);
    let fillerY = 792;
    for (let row = 0; row < 40; row++) {
      filler.drawText(
        `Riga di dettaglio ${String(i * 40 + row + 1)} - riferimento ordine ${sample.number}`,
        { x: MARGIN, y: fillerY, size: 9, font: regular, color: rgb(0.3, 0.3, 0.33) },
      );
      fillerY -= 18;
    }
  }

  return pdf.save();
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const sample of SAMPLES) {
    const bytes = await render(sample);
    const target = path.join(OUTPUT_DIR, `${sample.slug}.pdf`);
    await writeFile(target, bytes);
    console.log(`  ${sample.slug}.pdf  (${(bytes.length / 1024).toFixed(1)} KB)`);
  }

  console.log(
    `\n${SAMPLES.length} sample PDFs written to ${path.relative(process.cwd(), OUTPUT_DIR)}`,
  );
}

main().catch((error: unknown) => {
  console.error('Failed to generate samples:', error);
  process.exitCode = 1;
});
