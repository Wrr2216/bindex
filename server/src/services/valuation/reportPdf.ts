import type { PDFImage } from "pdf-lib";
import {
  MARGIN,
  RIGHT,
  accent,
  drawThumb,
  ensureRoom,
  footers,
  formatPrinted,
  hr,
  moneyFormatter,
  muted,
  newDoc,
  rule,
  save,
  text,
  textRight,
  warn,
  wrap,
  type Doc,
} from "./pdfShared";
import { thumbFor } from "./photos";
import type { Report, ReportRow } from "./report";

// Column x positions for the table.
const COL = { photo: MARGIN, item: MARGIN + 50, bought: 318, value: 438, book: RIGHT };
const ITEM_W = COL.bought - COL.item - 10;
const PHOTO = 42;
// Photos past this many rows are left out, so a report of a whole warehouse
// stays a file someone can email.
const MAX_PHOTOS = 400;

function header(d: Doc, groupName?: string): void {
  const size = 7.5;
  const y = d.y;
  text(d, "ITEM", COL.item, y, size, { bold: true, color: muted });
  text(d, "BOUGHT", COL.bought, y, size, { bold: true, color: muted });
  textRight(d, "VALUE", COL.value + 60, y, size, { bold: true, color: muted });
  textRight(d, "BOOK VALUE", COL.book, y, size, { bold: true, color: muted });
  d.y -= 6;
  hr(d, d.y, 0.8);
  d.y -= 12;
  if (groupName) {
    text(d, `${groupName} (continued)`, MARGIN, d.y, 9, { bold: true, color: muted });
    d.y -= 14;
  }
}

function rowLines(d: Doc, r: ReportRow): { lines: { s: string; size: number; bold?: boolean; color?: typeof muted }[] } {
  const lines: { s: string; size: number; bold?: boolean; color?: typeof muted }[] = [];
  for (const l of wrap(d, r.unitLabel ? `${r.name} (${r.unitLabel})` : r.name, d.bold, 9, ITEM_W)) lines.push({ s: l, size: 9, bold: true });
  const sub = [r.brand, r.model].filter(Boolean).join(" · ");
  if (sub) for (const l of wrap(d, sub, d.font, 7.5, ITEM_W)) lines.push({ s: l, size: 7.5, color: muted });
  const ids = [r.assetCode, r.serials.length ? `S/N ${r.serials.join(", ")}` : null, r.quantity > 1 ? `Qty ${r.quantity}` : null].filter(Boolean).join("  ·  ");
  for (const l of wrap(d, ids, d.font, 7.5, ITEM_W)) lines.push({ s: l, size: 7.5, color: muted });
  const cond = [r.condition && `Condition: ${r.condition}`, r.materials].filter(Boolean).join("  ·  ");
  if (cond) for (const l of wrap(d, cond, d.font, 7.5, ITEM_W)) lines.push({ s: l, size: 7.5, color: muted });
  return { lines };
}

export async function reportPdf(report: Report, timeZone: string): Promise<Buffer> {
  const d = await newDoc();
  const money = moneyFormatter(report.currency, report.locale);
  const printed = formatPrinted(report.generatedAt, timeZone, report.locale);
  let photos = 0;
  const thumbs = new Map<string, PDFImage | null>();

  // ---- Title and summary ----
  text(d, report.title.toUpperCase(), MARGIN, d.y, 9, { bold: true, color: muted });
  d.y -= 24;
  for (const l of wrap(d, report.scope, d.bold, 18, RIGHT - MARGIN)) {
    text(d, l, MARGIN, d.y, 18, { bold: true });
    d.y -= 22;
  }
  text(d, `Values as of ${report.asOf} · ${report.currency} · printed ${printed}`, MARGIN, d.y, 9, { color: muted });
  d.y -= 22;

  const t = report.totals;
  const stats: [string, string][] = [
    ["Records", `${t.records}${t.valued < t.records ? ` (${t.records - t.valued} not valued)` : ""}`],
    ["Total value", money(t.valueCents)],
    ["Purchase cost on file", money(t.costCents)],
    ["Book value", money(t.bookCents)],
    ["High value", `${t.highValue} at or over ${money(report.thresholdCents)}`],
  ];
  const colW = (RIGHT - MARGIN) / stats.length;
  stats.forEach(([label, value], i) => {
    text(d, label.toUpperCase(), MARGIN + i * colW, d.y, 7, { bold: true, color: muted });
    text(d, value, MARGIN + i * colW, d.y - 13, 10, { bold: true });
  });
  d.y -= 34;
  hr(d, d.y, 1);
  d.y -= 16;

  if (!t.records) {
    text(d, "Nothing in this scope has been recorded yet.", MARGIN, d.y, 10, { color: muted });
    d.y -= 14;
  }

  header(d);
  for (const group of report.groups) {
    ensureRoom(d, 60, () => header(d));
    text(d, group.name, MARGIN, d.y, 11, { bold: true, color: accent });
    textRight(d, `${group.rows.length} · ${money(group.valueCents)}`, RIGHT, d.y, 9, { bold: true, color: accent });
    d.y -= 8;
    hr(d, d.y, 0.8);
    d.y -= 12;

    for (const r of group.rows) {
      const { lines } = rowLines(d, r);
      const height = Math.max(PHOTO + 6, lines.reduce((n, l) => n + l.size + 3.5, 0) + 6);
      ensureRoom(d, height, () => header(d, group.name));
      const top = d.y + 8;

      const key = `${r.itemId}:${r.unitId ?? ""}`;
      if (!thumbs.has(key) && photos < MAX_PHOTOS) {
        const jpeg = await thumbFor({ id: r.itemId, primaryImageUrl: r.primaryImageUrl }, r.unitId, 160);
        thumbs.set(key, jpeg ? await d.doc.embedJpg(jpeg) : null);
        if (jpeg) photos++;
      }
      const img = thumbs.get(key);
      if (img) drawThumb(d, img, COL.photo, top, PHOTO);
      else d.page.drawRectangle({ x: COL.photo, y: top - PHOTO, width: PHOTO, height: PHOTO, borderColor: rule, borderWidth: 0.5 });

      let y = d.y;
      for (const l of lines) {
        text(d, l.s, COL.item, y, l.size, { bold: l.bold, color: l.color });
        y -= l.size + 3.5;
      }
      text(d, r.purchaseDate ?? "", COL.bought, d.y, 8.5);
      if (r.purchaseCents !== null) text(d, money(r.purchaseCents), COL.bought, d.y - 11, 8.5, { color: muted });
      if (r.vendor) text(d, wrap(d, r.vendor, d.font, 7, 110)[0] ?? "", COL.bought, d.y - 21, 7, { color: muted });

      textRight(d, r.valueCents === null ? "Not valued" : money(r.valueCents), COL.value + 60, d.y, 9, {
        bold: r.valueCents !== null,
        color: r.valueCents === null ? warn : undefined,
      });
      const tags = [r.highValue ? "HIGH VALUE" : null, r.lastSource === "ai" ? "AI ESTIMATE*" : null].filter(Boolean).join(" · ");
      if (tags) textRight(d, tags, COL.value + 60, d.y - 11, 6.5, { bold: true, color: r.highValue ? warn : muted });
      if (r.lastValuedOn) textRight(d, `valued ${r.lastValuedOn}`, COL.value + 60, d.y - 20, 6.5, { color: muted });

      if (r.depreciation) {
        textRight(d, money(r.depreciation.bookCents), COL.book, d.y, 9);
        textRight(d, `${r.depreciation.ageYears.toFixed(1)} of ${r.lifeYears} yr`, COL.book, d.y - 11, 6.5, { color: muted });
      } else {
        textRight(d, "No purchase date", COL.book, d.y, 7, { color: muted });
      }

      d.y -= height;
      hr(d, d.y + 6);
      d.y -= 6;
    }
    d.y -= 8;
  }

  ensureRoom(d, 60);
  d.y -= 4;
  const notes = [
    `Book value is straight-line depreciation from the purchase date over each category's useful life${report.salvagePercent ? `, down to ${report.salvagePercent}% of cost` : ""}; without a purchase price on file it runs from the recorded value.`,
    "* AI estimate: a value suggested by an AI model from photos and confirmed by a person. It is an estimate, not an appraisal.",
  ];
  for (const n of notes) {
    for (const l of wrap(d, n, d.font, 7.5, RIGHT - MARGIN)) {
      ensureRoom(d, 12);
      text(d, l, MARGIN, d.y, 7.5, { color: muted });
      d.y -= 10;
    }
    d.y -= 3;
  }

  footers(d, `Printed ${printed}`, `${report.appName}  ·  ${report.title}`);
  return save(d);
}
