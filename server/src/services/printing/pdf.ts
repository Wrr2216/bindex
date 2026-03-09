import { PDFDocument } from "pdf-lib";

const MM_TO_PT = 72 / 25.4;

export type LabelPage = { png: Buffer; wMm: number; hMm: number };

/**
 * Build a PDF with one exact-size page per label. A fixed page media size is
 * what makes label printers cut one clean label per page, unlike HTML @page
 * printing, which emits stray blank/oversized labels.
 */
export async function labelsPdf(pages: LabelPage[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (const { png, wMm, hMm } of pages) {
    const img = await doc.embedPng(png);
    const w = wMm * MM_TO_PT;
    const h = hMm * MM_TO_PT;
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}
