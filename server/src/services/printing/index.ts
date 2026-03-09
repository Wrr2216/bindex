import {
  renderCompactPng,
  renderLabelPng,
  renderPrintCompactLabel,
  renderPrintLabel,
  type CompactLabelData,
  type LabelData,
} from "./label";
import { labelsPdf } from "./pdf";
import { assetCodePrefix } from "../../lib/codes";

export type { CompactLabelData, LabelData } from "./label";
export { manifestPdf } from "./manifest";

/** PNG of one label, for the on-screen preview. */
export const previewPng = (data: LabelData): Promise<Buffer> => renderLabelPng(data);

/** Print-ready PDF: one exact-size page per label, so one page is one cut. */
export async function labelPdf(items: LabelData[]): Promise<Buffer> {
  const pages = await Promise.all(items.map((d) => renderPrintLabel(d)));
  return labelsPdf(pages);
}

/** PNG preview of a compact label: the QR code and the code beneath it. */
export const compactPreviewPng = (data: CompactLabelData): Promise<Buffer> =>
  renderCompactPng(data);

/** Print-ready PDF of compact labels, one square page each. */
export async function compactLabelPdf(items: CompactLabelData[]): Promise<Buffer> {
  const pages = await Promise.all(items.map((d) => renderPrintCompactLabel(d)));
  return labelsPdf(pages);
}

const SAMPLE = (): LabelData => ({
  name: "Test label",
  code: `${assetCodePrefix()}-TEST01`,
  sub: "print test",
});

/** A label with no real item behind it, for checking printer setup. */
export const samplePng = (): Promise<Buffer> => renderLabelPng(SAMPLE());
export const samplePdf = (): Promise<Buffer> => labelPdf([SAMPLE()]);
