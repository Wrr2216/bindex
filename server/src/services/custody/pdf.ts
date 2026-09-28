import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import bwipjs from "bwip-js";

/**
 * The custody receipt: who handed what to whom, where and when, the seals,
 * every line with what the receiver found, both signatures, and the hashes
 * that let anyone check the paper against the record. Letter, Helvetica,
 * the same look as the printed manifests. Renders plain data, so it can be
 * tested without a database.
 */

export type ReceiptLine = {
  index: number;
  name: string;
  code: string;
  inside: string | null;
  outcome: string;
  exception: boolean;
  note: string | null;
};

export type ReceiptSignature = {
  label: string;
  signerName: string;
  signerRole: string | null;
  signerEmail: string | null;
  signedAt: string;
  statement: string;
  contentHash: string;
  via: string;
  image: { bytes: Uint8Array; mime: string } | null;
};

export type ReceiptDoc = {
  kicker: string;
  title: string;
  code: string;
  facts: [string, string][];
  parties: { label: string; name: string; org: string | null; kind: string }[];
  lines: ReceiptLine[];
  summary: string;
  signatures: ReceiptSignature[];
  itemsHash: string;
  url: string;
};

const ink = rgb(0.07, 0.09, 0.13);
const muted = rgb(0.42, 0.46, 0.52);
const rule = rgb(0.8, 0.83, 0.87);
const danger = rgb(0.74, 0.12, 0.12);

const SIZE: [number, number] = [612, 792];
const MARGIN = 40;
const LEAD = 12;

class Writer {
  page!: PDFPage;
  y = 0;
  readonly safe: (text: string) => string;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    // The standard fonts only encode Windows-1252; anything else prints as "?"
    // rather than failing the whole receipt.
    const ok = new Set(font.getCharacterSet());
    this.safe = (text) =>
      Array.from(text.replace(/[\r\n\t]+/g, " "))
        .map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : "?"))
        .join("");
    this.newPage();
  }

  get right() {
    return SIZE[0] - MARGIN;
  }

  newPage() {
    this.page = this.doc.addPage(SIZE);
    this.y = SIZE[1] - MARGIN;
  }

  ensure(height: number, onBreak?: () => void) {
    if (this.y - height < MARGIN + 28) {
      this.newPage();
      onBreak?.();
    }
  }

  text(t: string, x: number, o: { size?: number; bold?: boolean; color?: RGB; y?: number } = {}) {
    this.page.drawText(this.safe(t), {
      x,
      y: o.y ?? this.y,
      size: o.size ?? 9,
      font: o.bold ? this.bold : this.font,
      color: o.color ?? ink,
    });
  }

  wrap(t: string, size: number, width: number, bold = false, maxLines = 6): string[] {
    const font = bold ? this.bold : this.font;
    const out: string[] = [];
    let line = "";
    for (const word of this.safe(t).split(/\s+/).filter(Boolean)) {
      // A hash has no spaces; break it by characters rather than overflow.
      const parts: string[] = [];
      let cur = "";
      for (const ch of word) {
        if (cur && font.widthOfTextAtSize(cur + ch, size) > width) {
          parts.push(cur);
          cur = ch;
        } else cur += ch;
      }
      if (cur) parts.push(cur);
      for (const part of parts) {
        const cand = line ? `${line} ${part}` : part;
        if (line && font.widthOfTextAtSize(cand, size) > width) {
          out.push(line);
          line = part;
        } else line = cand;
      }
    }
    if (line) out.push(line);
    if (out.length > maxLines) {
      const kept = out.slice(0, maxLines);
      kept[maxLines - 1] = `${kept[maxLines - 1]}...`;
      return kept;
    }
    return out;
  }

  para(t: string, o: { size?: number; bold?: boolean; color?: RGB; x?: number; width?: number; maxLines?: number } = {}) {
    const size = o.size ?? 9;
    const x = o.x ?? MARGIN;
    for (const l of this.wrap(t, size, o.width ?? this.right - x, o.bold, o.maxLines)) {
      this.ensure(LEAD);
      this.text(l, x, { size, bold: o.bold, color: o.color });
      this.y -= size + 3.5;
    }
  }

  rule(thickness = 0.5) {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: this.right, y: this.y }, thickness, color: rule });
  }

  heading(t: string) {
    this.ensure(40);
    this.y -= 8;
    this.text(t.toUpperCase(), MARGIN, { size: 7.5, bold: true, color: muted });
    this.y -= 6;
    this.rule(1);
    this.y -= 13;
  }
}

async function qrPng(url: string): Promise<Buffer> {
  return bwipjs.toBuffer({ bcid: "qrcode", text: url, scale: 3, paddingwidth: 0, paddingheight: 0 });
}

async function embedSignature(doc: PDFDocument, image: ReceiptSignature["image"]): Promise<PDFImage | null> {
  if (!image) return null;
  try {
    return image.mime === "image/jpeg" ? await doc.embedJpg(image.bytes) : await doc.embedPng(image.bytes);
  } catch {
    // A signature image the PDF library cannot read is noted, not fatal.
    return null;
  }
}

export async function renderReceiptPdf(r: ReceiptDoc, printed: string, appName: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  doc.setTitle(`${r.code} ${r.title}`);
  doc.setSubject("Chain of custody receipt");
  doc.setCreator(appName);

  // Header, with the verification QR at the top right.
  const qr = await doc.embedPng(await qrPng(r.url));
  w.page.drawImage(qr, { x: w.right - 72, y: SIZE[1] - MARGIN - 66, width: 72, height: 72 });
  const textWidth = w.right - MARGIN - 88;
  w.text(r.kicker, MARGIN, { size: 9, bold: true, color: muted });
  w.y -= 24;
  for (const line of w.wrap(r.title, 17, textWidth, true, 2)) {
    w.text(line, MARGIN, { size: 17, bold: true });
    w.y -= 20;
  }
  w.text(r.code, MARGIN, { size: 11, color: muted });
  w.y -= 18;

  for (const [label, value] of r.facts) {
    const lines = w.wrap(value, 9.5, textWidth - 90, false, 3);
    w.ensure(lines.length * 13);
    w.text(label.toUpperCase(), MARGIN, { size: 7, bold: true, color: muted, y: w.y + 1 });
    for (const l of lines) {
      w.text(l, MARGIN + 90, { size: 9.5 });
      w.y -= 13;
    }
  }
  w.y = Math.min(w.y, SIZE[1] - MARGIN - 84);

  // The two parties side by side.
  w.heading("Parties");
  const half = (w.right - MARGIN) / 2;
  const top = w.y;
  let lowest = w.y;
  r.parties.forEach((p, i) => {
    const x = MARGIN + i * half;
    let y = top;
    w.text(p.label.toUpperCase(), x, { y, size: 7, bold: true, color: muted });
    y -= 13;
    for (const l of w.wrap(p.name, 11, half - 12, true, 2)) {
      w.text(l, x, { y, size: 11, bold: true });
      y -= 13;
    }
    const sub = [p.org, p.kind].filter(Boolean).join("  ·  ");
    if (sub) {
      w.text(sub, x, { y, size: 8.5, color: muted });
      y -= 12;
    }
    lowest = Math.min(lowest, y);
  });
  w.y = lowest - 4;

  // Lines.
  w.heading(`Items (${r.lines.length})`);
  const cols = [
    { header: "#", x: MARGIN, width: 24 },
    { header: "Item", x: MARGIN + 24, width: 214 },
    { header: "Code", x: MARGIN + 238, width: 92 },
    { header: "Inside", x: MARGIN + 330, width: 84 },
    { header: "Received", x: MARGIN + 414, width: w.right - (MARGIN + 414) },
  ];
  const header = () => {
    for (const c of cols) w.text(c.header.toUpperCase(), c.x, { size: 7, bold: true, color: muted });
    w.y -= 13;
  };
  header();
  if (!r.lines.length) {
    w.text("No items.", MARGIN, { size: 9.5, color: muted });
    w.y -= LEAD;
  }
  for (const l of r.lines) {
    const name = w.wrap(l.name, 8.5, cols[1]!.width - 6, true, 3);
    const note = l.note ? w.wrap(l.note, 7.5, cols[4]!.width - 4, false, 3) : [];
    const rows = Math.max(name.length, 1 + note.length);
    w.ensure(rows * LEAD + 4, header);
    const y0 = w.y;
    w.text(String(l.index), cols[0]!.x, { size: 8.5, color: muted });
    name.forEach((t, i) => w.text(t, cols[1]!.x, { y: y0 - i * LEAD, size: 8.5, bold: true }));
    w.text(l.code, cols[2]!.x, { size: 8 });
    if (l.inside) w.text(l.inside, cols[3]!.x, { size: 8, color: muted });
    w.text(l.outcome, cols[4]!.x, { size: 8.5, bold: l.exception, color: l.exception ? danger : ink });
    note.forEach((t, i) => w.text(t, cols[4]!.x, { y: y0 - (i + 1) * LEAD, size: 7.5, color: muted }));
    w.y = y0 - (rows - 1) * LEAD - 5;
    w.rule();
    w.y -= 11;
  }
  w.y -= 2;
  w.para(r.summary, { size: 9.5 });

  // Signatures.
  w.heading("Signatures");
  if (!r.signatures.length) w.para("Not signed.", { color: muted });
  for (const s of r.signatures) {
    w.ensure(120);
    const y0 = w.y;
    w.text(s.label.toUpperCase(), MARGIN, { size: 7, bold: true, color: muted });
    const img = await embedSignature(doc, s.image);
    const boxW = 170;
    const boxH = 56;
    w.page.drawRectangle({ x: MARGIN, y: y0 - 10 - boxH, width: boxW, height: boxH, borderColor: rule, borderWidth: 0.6 });
    if (img) {
      const scale = Math.min((boxW - 8) / img.width, (boxH - 8) / img.height, 1);
      const iw = img.width * scale;
      const ih = img.height * scale;
      w.page.drawImage(img, { x: MARGIN + (boxW - iw) / 2, y: y0 - 10 - boxH + (boxH - ih) / 2, width: iw, height: ih });
    } else {
      w.text("(no image)", MARGIN + 6, { y: y0 - 10 - boxH / 2, size: 8, color: muted });
    }
    const x = MARGIN + boxW + 14;
    const width = w.right - x;
    w.y = y0;
    w.para(s.signerName, { x, width, size: 11, bold: true, maxLines: 2 });
    const who = [s.signerRole, s.signerEmail].filter(Boolean).join("  ·  ");
    if (who) w.para(who, { x, width, size: 8.5, color: muted, maxLines: 2 });
    w.para(`Signed ${s.signedAt} ${s.via === "link" ? "on their own device (one-time link)" : "on the handover device"}`, {
      x,
      width,
      size: 8.5,
    });
    w.para(`"${s.statement}"`, { x, width, size: 8, maxLines: 5 });
    w.para(`Signed content sha256 ${s.contentHash}`, { x, width, size: 7, color: muted, maxLines: 2 });
    w.y = Math.min(w.y, y0 - 10 - boxH) - 14;
  }

  // Fingerprints.
  w.heading("Verification");
  w.para(`Item list sha256 ${r.itemsHash}`, { size: 8 });
  w.para(
    `To check this receipt, open ${r.url} (or scan the code above) with an account on ${appName}. ` +
      "It shows whether the list and each signature still match what was signed, and the audit-log entry that recorded it.",
    { size: 8, color: muted, maxLines: 4 },
  );

  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const y = MARGIN - 14;
    page.drawText(w.safe(`${r.code}  ·  Printed ${printed}`), { x: MARGIN, y, size: 7.5, font: w.font, color: muted });
    const right = w.safe(`${appName}  ·  Page ${i + 1} of ${pages.length}`);
    page.drawText(right, { x: w.right - w.font.widthOfTextAtSize(right, 7.5), y, size: 7.5, font: w.font, color: muted });
  });
  return Buffer.from(await doc.save());
}
