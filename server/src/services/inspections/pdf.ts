import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { SEVERITY_COLOR } from "./model";
import type { InspectionReport, ReportComparisonEntry, ReportFinding, ReportSignature } from "./report";

/**
 * The inspection report as a PDF: a cover with the site, job, dates and
 * inspectors; for a post-inspection, the comparison first, new damage at the
 * top in red; then every finding by room with its photos; then the two
 * sign-offs. Same look as the printed manifests: Letter paper, Helvetica, a
 * muted caps kicker over a bold title, hairline rules.
 *
 * Pure: photos come through `images`, so this renders without a database.
 */

export type ReportImage = { kind: "jpg" | "png"; bytes: Buffer };
export type ImageLoader = (attachmentId: string) => Promise<ReportImage | null>;

const ink = rgb(0.07, 0.09, 0.13);
const muted = rgb(0.42, 0.46, 0.52);
const rule = rgb(0.8, 0.83, 0.87);
const band = rgb(0.94, 0.95, 0.97);
const danger = rgb(0.74, 0.12, 0.12);
const ok = rgb(0.05, 0.5, 0.3);

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const FOOTER = 30;

const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

const CHANGE_COLOR: Record<string, RGB> = {
  new: danger,
  worsened: hex("#ea580c"),
  resolved: ok,
  unchanged: muted,
};

export function formatWhen(at: Date | null, timeZone: string): string {
  if (!at) return "Not yet";
  try {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone,
    }).format(at);
  } catch {
    return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  private enc: (s: string) => string;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    const okChars = new Set(font.getCharacterSet());
    // The standard fonts encode Windows-1252 only; anything else prints as "?"
    // rather than failing the whole report.
    this.enc = (text) =>
      Array.from(text.replace(/[\r\n\t]+/g, " "))
        .map((ch) => (okChars.has(ch.codePointAt(0)!) ? ch : "?"))
        .join("");
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  /** Start a new page unless `height` still fits above the footer. */
  need(height: number) {
    if (this.y - height < MARGIN + FOOTER) this.newPage();
  }

  text(s: string, x: number, size: number, opts: { font?: PDFFont; color?: RGB; y?: number } = {}) {
    this.page.drawText(this.enc(s), {
      x,
      y: opts.y ?? this.y,
      size,
      font: opts.font ?? this.font,
      color: opts.color ?? ink,
    });
  }

  width(s: string, size: number, font: PDFFont = this.font) {
    return font.widthOfTextAtSize(this.enc(s), size);
  }

  wrap(s: string, size: number, max: number, font: PDFFont = this.font, maxLines = 12): string[] {
    const lines: string[] = [];
    let line = "";
    for (const raw of this.enc(s).split(/\s+/).filter(Boolean)) {
      // A single word wider than the line is broken by character.
      const parts: string[] = [];
      let cur = "";
      for (const ch of raw) {
        if (cur && font.widthOfTextAtSize(cur + ch, size) > max) {
          parts.push(cur);
          cur = ch;
        } else cur += ch;
      }
      if (cur) parts.push(cur);
      for (const word of parts) {
        const cand = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(cand, size) > max) {
          lines.push(line);
          line = word;
        } else line = cand;
      }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      kept[maxLines - 1] = `${kept[maxLines - 1]}...`;
      return kept;
    }
    return lines;
  }

  /** Wrapped paragraph at the cursor; moves the cursor below it. */
  para(s: string, x: number, size: number, max: number, opts: { font?: PDFFont; color?: RGB; lead?: number } = {}) {
    const lead = opts.lead ?? size + 3;
    for (const line of this.wrap(s, size, max, opts.font)) {
      this.need(lead);
      this.text(line, x, size, { font: opts.font, color: opts.color });
      this.y -= lead;
    }
  }

  hr(color: RGB = rule) {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.5,
      color,
    });
  }

  heading(title: string, sub?: string) {
    this.need(40);
    this.y -= 8;
    this.text(title.toUpperCase(), MARGIN, 10, { font: this.bold, color: muted });
    if (sub) this.text(sub, MARGIN + this.width(title.toUpperCase(), 10, this.bold) + 8, 9, { color: muted });
    this.y -= 6;
    this.hr();
    this.y -= 14;
  }
}

async function embedAll(doc: PDFDocument, ids: Iterable<string>, load: ImageLoader): Promise<Map<string, PDFImage>> {
  const out = new Map<string, PDFImage>();
  for (const id of ids) {
    if (out.has(id)) continue;
    try {
      const img = await load(id);
      if (!img) continue;
      out.set(id, img.kind === "png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes));
    } catch {
      // A photo that cannot be embedded is left out; the finding still prints.
    }
  }
  return out;
}

/** Draw an image scaled into a box, anchored top-left at (x, top). Returns the height used. */
function drawFitted(w: Writer, img: PDFImage, x: number, top: number, boxW: number, boxH: number): number {
  const scale = Math.min(boxW / img.width, boxH / img.height, 1.5);
  const width = img.width * scale;
  const height = img.height * scale;
  w.page.drawImage(img, { x, y: top - height, width, height });
  return height;
}

function severityTag(w: Writer, f: ReportFinding, x: number) {
  const label = f.severityLabel.toUpperCase();
  const size = 7.5;
  const tw = w.width(label, size, w.bold);
  const color = hex(SEVERITY_COLOR[f.severity]);
  w.page.drawRectangle({ x, y: w.y - 2.5, width: tw + 8, height: 11, color, opacity: 0.12 });
  w.text(label, x + 4, size, { font: w.bold, color });
  return tw + 12;
}

const PHOTO_W = (CONTENT_W - 20) / 3;
const PHOTO_H = 128;

function photoRow(w: Writer, images: Map<string, PDFImage>, ids: string[], label?: string, x0 = MARGIN) {
  const imgs = ids.map((id) => images.get(id)).filter((i): i is PDFImage => Boolean(i));
  if (!imgs.length) {
    if (ids.length) {
      w.need(12);
      w.text(`${ids.length} photo${ids.length === 1 ? "" : "s"} in a format that cannot be printed (see the app).`, x0, 8, { color: muted });
      w.y -= 12;
    }
    return;
  }
  for (let i = 0; i < imgs.length; i += 3) {
    w.need(PHOTO_H + (label ? 12 : 4));
    if (label && i === 0) {
      w.text(label, x0, 7.5, { font: w.bold, color: muted });
      w.y -= 10;
    }
    let tallest = 0;
    imgs.slice(i, i + 3).forEach((img, j) => {
      tallest = Math.max(tallest, drawFitted(w, img, x0 + j * (PHOTO_W + 10), w.y, PHOTO_W, PHOTO_H));
    });
    w.y -= tallest + 8;
  }
}

/** Room for a heading, a line or two, and the first row of photos, so a photo never starts a page alone. */
const blockHeight = (photoIds: string[], images: Map<string, PDFImage>, text = 46) =>
  text + (photoIds.some((id) => images.has(id)) ? PHOTO_H + 10 : 0);

function findingBlock(w: Writer, f: ReportFinding, images: Map<string, PDFImage>, prefix = "#") {
  w.need(blockHeight(f.photos.map((p) => p.id), images));
  const place = `${prefix}${f.number}  ${f.spotLabel}${f.spotDetail ? `, ${f.spotDetail}` : ""}`;
  w.text(place, MARGIN, 10, { font: w.bold });
  let x = MARGIN + w.width(place, 10, w.bold) + 8;
  x += severityTag(w, f, x);
  const flags = [f.preExisting ? "Pre-existing" : null, f.aiGenerated ? "Drafted by AI, checked by a person" : null].filter(Boolean);
  if (flags.length) w.text(flags.join(" · "), x, 7.5, { color: muted });
  w.y -= 13;
  w.para(f.description, MARGIN, 9.5, CONTENT_W);
  w.y -= 2;
  photoRow(w, images, f.photos.map((p) => p.id));
  w.y -= 6;
}

function comparisonSummary(w: Writer, counts: Record<string, number>) {
  const boxes: [string, string, RGB][] = [
    ["new", "New damage", danger],
    ["worsened", "Worsened", CHANGE_COLOR.worsened!],
    ["resolved", "Gone or not found", ok],
    ["unchanged", "Unchanged", muted],
  ];
  w.need(56);
  const bw = (CONTENT_W - 30) / 4;
  boxes.forEach(([key, label, color], i) => {
    const x = MARGIN + i * (bw + 10);
    const strong = key === "new" && (counts[key] ?? 0) > 0;
    w.page.drawRectangle({
      x,
      y: w.y - 42,
      width: bw,
      height: 46,
      color: strong ? danger : band,
      opacity: strong ? 0.12 : 1,
      borderColor: strong ? danger : rule,
      borderWidth: strong ? 1 : 0.5,
    });
    w.text(String(counts[key] ?? 0), x + 8, 20, { font: w.bold, color, y: w.y - 22 });
    w.text(label, x + 8, 8.5, { color: strong ? danger : muted, y: w.y - 36 });
  });
  w.y -= 58;
}

function comparisonEntry(w: Writer, e: ReportComparisonEntry, images: Map<string, PDFImage>) {
  const f = (e.post ?? e.pre)!;
  const shown = e.change === "new" || e.change === "worsened" ? (e.post?.photos ?? []).map((p) => p.id) : [];
  w.need(blockHeight(shown, images, 60));
  const tag = e.change === "new" ? "NEW" : e.change === "worsened" ? "WORSENED" : e.change === "resolved" ? "GONE" : "SAME";
  const color = CHANGE_COLOR[e.change]!;
  w.text(tag, MARGIN, 8.5, { font: w.bold, color });
  const where = `${f.areaLabel} · ${f.room} · ${f.spotLabel}${f.spotDetail ? `, ${f.spotDetail}` : ""}`;
  w.text(where, MARGIN + 62, 10, { font: w.bold });
  w.y -= 13;
  if (e.post) {
    const line = `After (#${e.post.number}, ${e.post.severityLabel.toLowerCase()}): ${e.post.description}`;
    w.para(line, MARGIN + 62, 9.5, CONTENT_W - 62);
  }
  if (e.pre) {
    const line = `Before (pre #${e.pre.number}, ${e.pre.severityLabel.toLowerCase()}): ${e.pre.description}`;
    w.para(line, MARGIN + 62, 9, CONTENT_W - 62, { color: muted });
  }
  if (e.change === "new" || e.change === "worsened") {
    photoRow(w, images, (e.post?.photos ?? []).map((p) => p.id), "AFTER", MARGIN + 62);
    if (e.pre?.photos.length) photoRow(w, images, e.pre.photos.slice(0, 3).map((p) => p.id), "BEFORE", MARGIN + 62);
  }
  w.y -= 6;
}

function signatureBox(
  w: Writer,
  x: number,
  top: number,
  width: number,
  label: string,
  s: ReportSignature | null,
  images: Map<string, PDFImage>,
  tz: string,
): number {
  let y = top;
  w.text(label.toUpperCase(), x, 8, { font: w.bold, color: muted, y });
  y -= 8;
  const img = s?.imageId ? images.get(s.imageId) : undefined;
  if (img) y -= drawFitted(w, img, x, y, width, 60) + 4;
  else y -= 60;
  w.page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.6, color: ink });
  y -= 12;
  if (!s) {
    w.text("Not signed", x, 9, { color: muted, y });
    return top - y + 12;
  }
  w.text(s.signerName, x, 10, { font: w.bold, y });
  y -= 12;
  const who = [s.signerRole, s.signerEmail].filter(Boolean).join(" · ");
  if (who) {
    w.text(who, x, 8.5, { color: muted, y });
    y -= 11;
  }
  w.text(`Signed ${formatWhen(s.signedAt, tz)}`, x, 8.5, { color: muted, y });
  y -= 11;
  w.text(
    s.valid ? "Verified: matches this report as signed" : s.reason === "content_changed" ? "Changed since signing" : "Signature image altered or missing",
    x,
    8.5,
    { font: w.bold, color: s.valid ? ok : danger, y },
  );
  y -= 11;
  return top - y;
}

export async function renderInspectionPdf(report: InspectionReport, images: ImageLoader, tz = "UTC"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${report.kindLabel} ${report.code}: ${report.siteName}`);
  doc.setSubject("Site inspection report");
  doc.setCreator("Bindex");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold);

  const allFindings = [...report.findings, ...(report.pre?.findings ?? [])];
  const sigs = [...report.signoffs.map((s) => s.signature), ...report.otherSignatures].filter(
    (s): s is ReportSignature => Boolean(s),
  );
  const embedded = await embedAll(
    doc,
    [...allFindings.flatMap((f) => f.photos.map((p) => p.id)), ...sigs.flatMap((s) => (s.imageId ? [s.imageId] : []))],
    images,
  );

  // ---- Cover
  w.text("SITE INSPECTION REPORT", MARGIN, 9, { font: bold, color: muted });
  w.text(report.code, PAGE_W - MARGIN - w.width(report.code, 11, bold), 11, { font: bold });
  w.y -= 26;
  w.text(report.kindLabel, MARGIN, 22, { font: bold });
  w.y -= 20;
  w.para(report.siteName, MARGIN, 13, CONTENT_W, { lead: 16 });
  w.y -= 6;
  w.hr();
  w.y -= 16;

  const details: [string, string][] = [
    ["Site", report.siteName],
    ...(report.siteAddress ? ([["Address", report.siteAddress]] as [string, string][]) : []),
    ...(report.job ? ([["Job", `${report.job.code}, ${report.job.name}`]] as [string, string][]) : []),
    ["Status", report.statusLabel],
    ["Started", formatWhen(report.startedAt, tz)],
    ["Completed", formatWhen(report.completedAt, tz)],
    ["Signed", formatWhen(report.signedAt, tz)],
    ["Inspectors", report.inspectors.join(", ") || "Not recorded"],
    ...(report.pre
      ? ([["Compared with", `${report.pre.code}, pre-move inspection of ${formatWhen(report.pre.completedAt ?? report.pre.startedAt, tz)}`]] as [
          string,
          string,
        ][])
      : []),
  ];
  for (const [label, value] of details) {
    w.need(14);
    w.text(label, MARGIN, 9, { color: muted });
    w.para(value, MARGIN + 100, 10, CONTENT_W - 100, { lead: 13 });
  }
  w.y -= 6;
  const rooms = report.rooms.length;
  const n = report.findings.length;
  const bySeverity = (["minor", "moderate", "major"] as const)
    .filter((s) => report.severityCounts[s])
    .map((s) => `${report.severityCounts[s]} ${s}`)
    .join(", ");
  w.para(
    n
      ? `${n} finding${n === 1 ? "" : "s"} in ${rooms} room${rooms === 1 ? "" : "s"} or areas: ${bySeverity}.`
      : "No damage was recorded.",
    MARGIN,
    10.5,
    CONTENT_W,
    { font: bold },
  );
  if (report.notes) {
    w.y -= 4;
    w.para(`Notes: ${report.notes}`, MARGIN, 9.5, CONTENT_W);
  }
  if (report.kind === "post" && !report.pre) {
    w.y -= 4;
    w.para("This post-inspection has not been compared with a pre-inspection.", MARGIN, 9.5, CONTENT_W, { color: danger });
  }

  // ---- Comparison, new damage first
  if (report.comparison && report.pre) {
    w.y -= 8;
    w.heading("Comparison with the pre-move inspection", report.pre.code);
    comparisonSummary(w, report.comparison.counts);
    const groups: [string, ReportComparisonEntry[]][] = [
      ["New damage", report.comparison.entries.filter((e) => e.change === "new")],
      ["Worse than before", report.comparison.entries.filter((e) => e.change === "worsened")],
      ["Recorded before, not found after", report.comparison.entries.filter((e) => e.change === "resolved")],
      ["Unchanged", report.comparison.entries.filter((e) => e.change === "unchanged")],
    ];
    for (const [title, entries] of groups) {
      if (!entries.length) continue;
      w.need(30);
      w.text(`${title} (${entries.length})`, MARGIN, 11, { font: bold, color: title === "New damage" ? danger : ink });
      w.y -= 16;
      if (title === "Unchanged") {
        for (const e of entries) {
          const f = e.post ?? e.pre!;
          const line = e.pre
            ? `Pre #${e.pre.number} = #${e.post!.number}  ${f.room} · ${f.spotLabel}: ${f.description}`
            : `#${f.number}  ${f.room} · ${f.spotLabel}: ${f.description} (pre-existing, not in the pre-inspection)`;
          w.para(line, MARGIN, 9, CONTENT_W, { color: muted });
        }
        w.y -= 6;
      } else {
        for (const e of entries) comparisonEntry(w, e, embedded);
      }
    }
  }

  // ---- Findings by room
  w.y -= 8;
  w.heading("Findings by room", n ? `${n} in ${rooms}` : undefined);
  if (!n) {
    w.para("No damage was recorded at this site.", MARGIN, 10, CONTENT_W, { color: muted });
  }
  for (const room of report.rooms) {
    w.y -= 6;
    const first = room.findings[0];
    w.need(24 + (first ? blockHeight(first.photos.map((p) => p.id), embedded) : 0));
    w.page.drawRectangle({ x: MARGIN, y: w.y - 5, width: CONTENT_W, height: 18, color: band });
    w.text(`${room.area === "inside" ? "Inside" : "Outside"} · ${room.room}`, MARGIN + 6, 10.5, { font: bold });
    const count = `${room.findings.length} finding${room.findings.length === 1 ? "" : "s"}`;
    w.text(count, PAGE_W - MARGIN - 6 - w.width(count, 9), 9, { color: muted });
    w.y -= 24;
    for (const f of room.findings) findingBlock(w, f, embedded);
  }

  // ---- Sign-off
  w.y -= 8;
  w.need(200);
  w.heading("Sign-off");
  const colW = (CONTENT_W - 30) / 2;
  const top = w.y;
  let used = 0;
  report.signoffs.forEach((s, i) => {
    used = Math.max(used, signatureBox(w, MARGIN + i * (colW + 30), top, colW, s.label, s.signature, embedded, tz));
  });
  w.y = top - used - 10;
  for (const s of report.otherSignatures) {
    w.need(110);
    const h = signatureBox(w, MARGIN, w.y, colW, s.signerRole ?? "Other signature", s, embedded, tz);
    w.y -= h + 10;
  }
  // Each role agrees to its own words; print each once.
  const statements = new Map<string, string>();
  for (const s of report.signoffs) if (s.signature) statements.set(s.signature.statement, s.label);
  for (const s of report.otherSignatures) if (!statements.has(s.statement)) statements.set(s.statement, s.signerRole ?? "Other");
  for (const [statement, who] of statements) {
    w.para(`${who} signed: "${statement}"`, MARGIN, 8.5, CONTENT_W, { color: muted });
    w.y -= 2;
  }
  w.y -= 4;
  w.para(
    `Content fingerprint (sha256 of the signed record as it stands): ${report.contentHash}. A signature is verified when it was made over this same fingerprint.`,
    MARGIN,
    7.5,
    CONTENT_W,
    { color: muted },
  );

  // ---- Footers
  const printed = formatWhen(report.generatedAt, tz);
  w.pages.forEach((page, i) => {
    const left = `${report.code} · ${report.kindLabel} · printed ${printed}`;
    const right = `Page ${i + 1} of ${w.pages.length}`;
    page.drawLine({ start: { x: MARGIN, y: MARGIN + 12 }, end: { x: PAGE_W - MARGIN, y: MARGIN + 12 }, thickness: 0.5, color: rule });
    w.page = page;
    w.text(left, MARGIN, 7.5, { color: muted, y: MARGIN });
    w.text(right, PAGE_W - MARGIN - w.width(right, 7.5), 7.5, { color: muted, y: MARGIN });
  });

  return Buffer.from(await doc.save());
}
