/**
 * ZPL for Zebra RFID printer-encoders (ZT411R, ZT421R, ZD621R and their kin):
 * one label per record that prints the same things as the PDF label (QR
 * deep link, name, Code 128 of the printed code, the code in text) and writes
 * the record's EPC to the inlay in the same pass.
 *
 *   ^RS8          RFID setup: tag type 8, EPC Class 1 Gen 2, printer defaults
 *                 for program position, retries and void handling
 *   ^RFW,H,,,A    write hex to the EPC bank and adjust the PC length bits to
 *                 match, so a 128-bit factory EPC becomes a clean 96-bit one
 *
 * Pure: builds a string from the label data and the label size.
 */

export type ZplLabel = {
  name: string;
  code: string;
  sub?: string | null;
  url?: string | null;
  /** 24 hex digits. Omitted for a label with nothing to encode. */
  epc?: string | null;
};

export type ZplOptions = {
  widthMm: number;
  heightMm: number;
  dpi: number;
};

export const ZPL_DPIS = [203, 300, 600] as const;

const dots = (mm: number, dpi: number) => Math.round((mm / 25.4) * dpi);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Field data goes through ^FH with "_" as the escape, so a name containing
 * ^ or ~ cannot end the field early or start a command.
 */
export function zplText(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/_/g, "_5F")
    .replace(/\^/g, "_5E")
    .replace(/~/g, "_7E");
}

/** Byte capacity of QR versions 1-10 at error correction M. */
const QR_M_BYTES = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/** Modules across the QR symbol the printer will draw for this much data. */
export function qrModules(data: string): number {
  const bytes = Buffer.byteLength(data, "utf8");
  const version = QR_M_BYTES.findIndex((cap) => bytes <= cap) + 1 || 11;
  return 17 + 4 * version;
}

/** Modules across a Code 128 symbol in subset B, the widest the printer may pick. */
export const code128Modules = (data: string) => 11 * (data.length + 2) + 13;

export function zplLabel(label: ZplLabel, { widthMm, heightMm, dpi }: ZplOptions): string {
  const W = dots(widthMm, dpi);
  const H = dots(heightMm, dpi);
  const pad = dots(1.5, dpi);
  const out: string[] = ["^XA", "^CI28", `^PW${W}`, `^LL${H}`, "^LH0,0"];

  if (label.epc) {
    out.push("^RS8", `^RFW,H,,,A^FD${label.epc}^FS`);
  }

  // QR on the left, as tall as the label allows.
  let x = pad;
  if (label.url) {
    const modules = qrModules(label.url);
    const magnification = clamp(Math.floor((H - 2 * pad) / modules), 1, 10);
    const size = modules * magnification;
    const y = Math.max(0, Math.round((H - size) / 2));
    out.push(`^FO${pad},${y}^BQN,2,${magnification}^FH_^FDMA,${zplText(label.url)}^FS`);
    x = pad + size + pad;
  }
  const width = Math.max(1, W - x - pad);

  // Text and barcode stacked on the right, sized from the label height.
  const nameH = Math.max(12, Math.round(H * 0.14));
  const barH = Math.max(20, Math.round(H * 0.26));
  const codeH = Math.max(10, Math.round(H * 0.11));
  const subH = Math.max(10, Math.round(H * 0.09));
  const gap = Math.max(2, Math.round(H * 0.02));
  const module = clamp(Math.floor(width / code128Modules(label.code)), 1, 3);

  let y = pad;
  out.push(`^FO${x},${y}^A0N,${nameH},${nameH}^FB${width},2,0,L,0^FH_^FD${zplText(label.name)}^FS`);
  y += nameH * 2 + gap;
  out.push(`^FO${x},${y}^BY${module},2,${barH}^BCN,${barH},N,N,N^FH_^FD${zplText(label.code)}^FS`);
  y += barH + gap;
  out.push(`^FO${x},${y}^A0N,${codeH},${codeH}^FH_^FD${zplText(label.code)}^FS`);
  y += codeH + gap;
  if (label.sub) {
    out.push(`^FO${x},${y}^A0N,${subH},${subH}^FB${width},1,0,L,0^FH_^FD${zplText(label.sub)}^FS`);
  }

  out.push("^PQ1", "^XZ");
  return out.join("\n");
}

/** One ZPL document with a label per record, ready to send to the printer. */
export function zplDocument(labels: ZplLabel[], options: ZplOptions): string {
  return `${labels.map((l) => zplLabel(l, options)).join("\n")}\n`;
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** code,epc,... for encoders that take a data file instead of ZPL. */
export function encodeCsv(
  rows: { code: string; epc: string; scheme: string; name: string; url: string }[],
): string {
  const lines = [["code", "epc", "scheme", "name", "url"].join(",")];
  for (const r of rows) lines.push([r.code, r.epc, r.scheme, r.name, r.url].map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
