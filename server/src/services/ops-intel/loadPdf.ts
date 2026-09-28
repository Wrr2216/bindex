import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { LoadPlan, MeasureSource } from "./load";

/**
 * The printable load plan: one section per vehicle with its capacity, its
 * totals and the numbered loading sequence, then what did not fit. Letter
 * paper and Helvetica, like the manifests and load sheets. Renders plain
 * data, so it is tested without a database.
 */

export type LoadPlanDoc = {
  jobCode: string;
  jobName: string;
  generatedAt: string;
  /** The viewer's time zone, for the printed time. */
  timeZone?: string;
  plan: LoadPlan;
};

const ink = rgb(0.07, 0.09, 0.13);
const muted = rgb(0.42, 0.46, 0.52);
const rule = rgb(0.8, 0.83, 0.87);
const band = rgb(0.94, 0.95, 0.97);
const danger = rgb(0.74, 0.12, 0.12);

const PAGE: [number, number] = [612, 792];
const MARGIN = 40;
const ROW = 14;

/** The standard fonts only encode Windows-1252; anything else prints as "?" rather than failing. */
function encoder(font: PDFFont): (text: string) => string {
  const ok = new Set(font.getCharacterSet());
  return (text) =>
    Array.from(text.replace(/[\r\n\t]+/g, " "))
      .map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : "?"))
      .join("");
}

function fit(text: string, font: PDFFont, size: number, max: number): string {
  if (font.widthOfTextAtSize(text, size) <= max) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > max) out = out.slice(0, -1);
  return `${out}...`;
}

const SOURCE: Record<MeasureSource, string> = { item: "", dimensions: "dims", category: "cat", default: "est" };

function printedAt(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  try {
    return d.toLocaleString("en-GB", { timeZone: timeZone || "UTC", dateStyle: "medium", timeStyle: "short" });
  } catch {
    return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

const kg = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} kg`;
const m3 = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} m³`;
const pct = (n: number | null) => (n === null ? "" : `${Math.round(n * 100)}%`);

export async function loadPlanPdf(doc: LoadPlanDoc): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Load plan ${doc.jobCode}`);
  pdf.setProducer("Bindex");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const enc = encoder(regular);
  const width = PAGE[0] - MARGIN * 2;

  let page: PDFPage = pdf.addPage(PAGE);
  let y = PAGE[1] - MARGIN;

  const text = (s: string, x: number, size: number, opts: { font?: PDFFont; color?: typeof ink; max?: number } = {}) => {
    const font = opts.font ?? regular;
    const t = opts.max ? fit(enc(s), font, size, opts.max) : enc(s);
    page.drawText(t, { x, y, size, font, color: opts.color ?? ink });
  };
  const newPage = () => {
    page = pdf.addPage(PAGE);
    y = PAGE[1] - MARGIN;
  };
  /** Start a new page when `h` more points would run into the footer; true when it did. */
  const need = (h: number): boolean => {
    if (y - h >= MARGIN + 20) return false;
    newPage();
    return true;
  };

  // Heading
  text("LOAD PLAN", MARGIN, 9, { font: bold, color: muted });
  y -= 22;
  text(doc.jobName, MARGIN, 18, { font: bold, max: width - 90 });
  const code = enc(doc.jobCode);
  page.drawText(code, { x: PAGE[0] - MARGIN - bold.widthOfTextAtSize(code, 12), y, size: 12, font: bold, color: ink });
  y -= 16;
  text(
    `Printed ${printedAt(doc.generatedAt, doc.timeZone)} · ${doc.plan.repack ? "Repacked from scratch" : "Existing assignments kept"} · ${Math.round(doc.plan.fillFactor * 100)}% of each vehicle's volume counted as usable`,
    MARGIN,
    8.5,
    { color: muted, max: width },
  );
  y -= 14;
  if (doc.plan.stops.length) {
    text(
      `Stops in delivery order: ${doc.plan.stops.map((s) => `${s.index + 1}. ${s.label}`).join("   ")}`,
      MARGIN,
      8.5,
      { color: muted, max: width },
    );
    y -= 14;
  }
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, thickness: 0.5, color: rule });
  y -= 18;

  const cols = [
    { title: "Load", x: MARGIN, w: 30 },
    { title: "Code", x: MARGIN + 32, w: 72 },
    { title: "Name", x: MARGIN + 106, w: 190 },
    { title: "Stop", x: MARGIN + 300, w: 120 },
    { title: "Weight", x: MARGIN + 424, w: 50 },
    { title: "Volume", x: MARGIN + 478, w: 54 },
  ];

  const header = () => {
    page.drawRectangle({ x: MARGIN, y: y - 4, width, height: ROW, color: band });
    for (const c of cols) text(c.title, c.x + 2, 8, { font: bold, color: muted });
    y -= ROW + 2;
  };

  for (const v of doc.plan.vehicles) {
    need(80);
    const name = v.shipmentCode ? `${v.shipmentCode} · ${v.name}` : v.name;
    text(name, MARGIN, 12, { font: bold, max: width });
    y -= 14;
    const cap = v.capacity;
    const capText = cap
      ? [
          cap.maxKg !== null ? `max ${kg(cap.maxKg)}` : null,
          cap.maxM3 !== null ? `usable ${m3(cap.maxM3)}` : null,
          cap.interiorM ? `interior ${cap.interiorM.map((d) => d.toFixed(2)).join(" × ")} m` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : "No capacity set: nothing planned onto this vehicle";
    text(`${v.vehicleName ? `${v.vehicleName}: ` : ""}${capText}`, MARGIN, 8.5, { color: muted, max: width });
    y -= 12;
    const over = v.over.weight || v.over.volume;
    text(
      `Load ${kg(v.totals.weightKg)} (${pct(v.utilization.weight) || "no limit"}), ${m3(v.totals.volumeM3)} (${pct(v.utilization.volume) || "no limit"}), ${v.totals.lines} lines${over ? " · OVER CAPACITY" : ""}`,
      MARGIN,
      8.5,
      { color: over ? danger : ink, max: width },
    );
    y -= 16;
    if (!v.lines.length) {
      text("Nothing to load.", MARGIN, 9, { color: muted });
      y -= 20;
      continue;
    }
    header();
    for (const l of v.lines) {
      if (need(ROW + 4)) header();
      const src = [SOURCE[l.measure.weightSource], SOURCE[l.measure.volumeSource]].filter(Boolean);
      text(String(l.sequence), cols[0]!.x + 2, 9, { font: bold });
      text(l.code ?? "", cols[1]!.x + 2, 8.5, { max: cols[1]!.w - 4 });
      text(`${l.name}${l.measure.pieces > 1 ? ` ×${l.measure.pieces}` : ""}${l.pinned ? " (on board)" : ""}`, cols[2]!.x + 2, 8.5, {
        max: cols[2]!.w - 4,
      });
      text(`${l.stopIndex + 1}. ${l.stopLabel}`, cols[3]!.x + 2, 8.5, { max: cols[3]!.w - 4 });
      text(`${l.measure.weightKg.toFixed(1)}${src.length ? "*" : ""}`, cols[4]!.x + 2, 8.5);
      text(l.measure.volumeM3.toFixed(3), cols[5]!.x + 2, 8.5);
      y -= ROW;
      page.drawLine({ start: { x: MARGIN, y: y + 10 }, end: { x: PAGE[0] - MARGIN, y: y + 10 }, thickness: 0.25, color: rule });
    }
    y -= 12;
  }

  if (doc.plan.unassigned.length) {
    need(60);
    text(`Did not fit (${doc.plan.unassigned.length})`, MARGIN, 12, { font: bold, color: danger });
    y -= 16;
    for (const u of doc.plan.unassigned) {
      need(ROW + 4);
      text(u.line.code ?? "", MARGIN + 2, 8.5, { max: 70 });
      text(u.line.name, MARGIN + 76, 8.5, { max: 180 });
      text(`${kg(u.line.measure.weightKg)}, ${m3(u.line.measure.volumeM3)}`, MARGIN + 260, 8.5, { max: 110 });
      text(u.reason, MARGIN + 374, 8.5, { color: muted, max: width - 334 });
      y -= ROW;
    }
    y -= 8;
  }

  if (doc.plan.warnings.length) {
    need(20 + doc.plan.warnings.length * 12);
    text("Notes", MARGIN, 10, { font: bold });
    y -= 13;
    for (const w of doc.plan.warnings) {
      need(12);
      text(`- ${w}`, MARGIN, 8.5, { color: muted, max: width });
      y -= 12;
    }
  }
  need(24);
  y -= 6;
  text(
    "* estimated: weight or volume from a category or the instance default, not measured. Sequence 1 goes into the vehicle first.",
    MARGIN,
    7.5,
    { color: muted, max: width },
  );

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const label = enc(`${doc.jobCode} · page ${i + 1} of ${pages.length}`);
    p.drawText(label, {
      x: PAGE[0] - MARGIN - regular.widthOfTextAtSize(label, 7.5),
      y: MARGIN - 18,
      size: 7.5,
      font: regular,
      color: muted,
    });
  });
  return Buffer.from(await pdf.save());
}
