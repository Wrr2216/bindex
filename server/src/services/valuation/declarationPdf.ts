import { inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { items } from "../../db/schema";
import { getConfig } from "../config";
import { readAttachmentBytes } from "../media-ai-core";
import type { DeclarationDetail } from "./declarations";
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

const COL = { n: MARGIN, photo: MARGIN + 20, item: MARGIN + 74, value: RIGHT };
const ITEM_W = RIGHT - 110 - COL.item;
const PHOTO = 46;

const SOURCE_LABEL: Record<string, string> = {
  ai: "AI estimate*",
  web: "Web price",
  receipt: "Receipt",
  manual: "Entered",
  appraisal: "Appraisal",
};

function tableHeader(d: Doc): void {
  text(d, "#", COL.n, d.y, 7.5, { bold: true, color: muted });
  text(d, "ITEM", COL.item, d.y, 7.5, { bold: true, color: muted });
  textRight(d, "DECLARED VALUE", COL.value, d.y, 7.5, { bold: true, color: muted });
  d.y -= 6;
  hr(d, d.y, 0.8);
  d.y -= 14;
}

/** The declaration as a printable, signed record. */
export async function declarationPdf(decl: DeclarationDetail, timeZone: string): Promise<Buffer> {
  const config = await getConfig();
  const d = await newDoc();
  const money = moneyFormatter(decl.currency, config.locale);
  const printed = formatPrinted(new Date(), timeZone, config.locale);

  text(d, "HIGH-VALUE DECLARATION", MARGIN, d.y, 9, { bold: true, color: muted });
  textRight(d, decl.status === "signed" ? "SIGNED" : "DRAFT - NOT SIGNED", RIGHT, d.y, 9, {
    bold: true,
    color: decl.status === "signed" ? accent : warn,
  });
  d.y -= 26;
  text(d, decl.code, MARGIN, d.y, 22, { bold: true });
  d.y -= 20;
  for (const l of wrap(d, decl.title, d.bold, 13, RIGHT - MARGIN)) {
    text(d, l, MARGIN, d.y, 13, { bold: true });
    d.y -= 16;
  }
  const scopeWord = decl.scope === "company" ? config.terms.group.singular : decl.scope === "location" ? config.terms.location.singular : "Job";
  text(d, `${scopeWord}: ${decl.scopeLabel ?? ""}`, MARGIN, d.y, 10, { color: muted });
  d.y -= 13;
  text(d, `${decl.lines.length} item${decl.lines.length === 1 ? "" : "s"} · total ${money(decl.totalCents)} · ${decl.currency}`, MARGIN, d.y, 10);
  d.y -= 22;

  tableHeader(d);
  // Photos come from the items as they are now; the declared facts beside them are the snapshot.
  const live = decl.lines.some((l) => l.itemId)
    ? await db
        .select({ id: items.id, primaryImageUrl: items.primaryImageUrl })
        .from(items)
        .where(inArray(items.id, decl.lines.filter((l) => l.itemId).map((l) => l.itemId!)))
    : [];

  let estimated = false;
  for (const line of decl.lines) {
    const lines: { s: string; size: number; bold?: boolean; color?: typeof muted }[] = [];
    for (const l of wrap(d, line.name, d.bold, 10, ITEM_W)) lines.push({ s: l, size: 10, bold: true });
    const facts = [
      [line.brand, line.model].filter(Boolean).join(" · "),
      [line.serial && `S/N ${line.serial}`, line.assetCode].filter(Boolean).join("  ·  "),
      [line.condition && `Condition: ${line.condition}`, line.materials && `Materials: ${line.materials}`].filter(Boolean).join("  ·  "),
      line.description,
      line.notes && `Note: ${line.notes}`,
    ].filter((s): s is string => Boolean(s));
    for (const f of facts) for (const l of wrap(d, f, d.font, 8, ITEM_W)) lines.push({ s: l, size: 8, color: muted });
    const height = Math.max(PHOTO + 8, lines.reduce((n, l) => n + l.size + 3.5, 0) + 8);
    ensureRoom(d, height, () => tableHeader(d));

    const top = d.y + 9;
    text(d, String(line.position), COL.n, d.y, 9, { color: muted });
    const item = live.find((i) => i.id === line.itemId);
    const jpeg = item ? await thumbFor(item, line.unitId, 180) : null;
    if (jpeg) drawThumb(d, await d.doc.embedJpg(jpeg), COL.photo, top, PHOTO);
    else d.page.drawRectangle({ x: COL.photo, y: top - PHOTO, width: PHOTO, height: PHOTO, borderColor: rule, borderWidth: 0.5 });

    let y = d.y;
    for (const l of lines) {
      text(d, l.s, COL.item, y, l.size, { bold: l.bold, color: l.color });
      y -= l.size + 3.5;
    }
    textRight(d, money(line.declaredCents), COL.value, d.y, 10, { bold: true });
    if (line.valueSource) {
      textRight(d, SOURCE_LABEL[line.valueSource] ?? line.valueSource, COL.value, d.y - 12, 7, { color: line.valueSource === "ai" ? warn : muted });
      if (line.valueSource === "ai") estimated = true;
    }
    d.y -= height;
    hr(d, d.y + 6);
    d.y -= 6;
  }

  ensureRoom(d, 30);
  textRight(d, `Total declared  ${money(decl.totalCents)}`, RIGHT, d.y, 12, { bold: true });
  d.y -= 24;

  if (decl.notes) {
    ensureRoom(d, 30);
    text(d, "NOTES", MARGIN, d.y, 7.5, { bold: true, color: muted });
    d.y -= 12;
    for (const l of wrap(d, decl.notes, d.font, 9, RIGHT - MARGIN)) {
      ensureRoom(d, 12);
      text(d, l, MARGIN, d.y, 9);
      d.y -= 12;
    }
    d.y -= 10;
  }

  // ---- Signature block ----
  ensureRoom(d, 190);
  hr(d, d.y + 4, 1);
  d.y -= 14;
  text(d, "DECLARATION", MARGIN, d.y, 7.5, { bold: true, color: muted });
  d.y -= 13;
  for (const l of wrap(d, decl.statement, d.font, 9.5, RIGHT - MARGIN)) {
    text(d, l, MARGIN, d.y, 9.5);
    d.y -= 13;
  }
  d.y -= 8;

  const sig = decl.status === "signed" ? decl.signature : null;
  if (sig) {
    if (sig.attachmentId) {
      try {
        const { bytes } = await readAttachmentBytes(sig.attachmentId, 1024 * 1024);
        const png = await d.doc.embedPng(bytes);
        const h = 54;
        const w = Math.min(220, (png.width / png.height) * h);
        d.page.drawImage(png, { x: MARGIN, y: d.y - h, width: w, height: (w / (png.width / png.height)) });
      } catch {
        // An unreadable image still leaves the typed name and the hashes below.
      }
    }
    d.y -= 60;
    d.page.drawLine({ start: { x: MARGIN, y: d.y }, end: { x: MARGIN + 240, y: d.y }, thickness: 0.6, color: muted });
    d.y -= 12;
    text(d, [sig.signerName, sig.signerRole].filter(Boolean).join(", "), MARGIN, d.y, 10, { bold: true });
    d.y -= 12;
    text(d, `Signed ${formatPrinted(new Date(sig.signedAt), timeZone, config.locale)}${sig.signerEmail ? ` · ${sig.signerEmail}` : ""}`, MARGIN, d.y, 8.5, { color: muted });
    d.y -= 16;
    const evidence = [
      `Content hash (sha256): ${sig.contentHash}`,
      `Signature id: ${sig.id}${decl.auditEntryId ? ` · audit log entry #${decl.auditEntryId}` : ""}`,
      decl.verification
        ? decl.verification.valid
          ? "Verified when printed: the declaration matches what was signed."
          : `WARNING: the declaration no longer matches what was signed (${decl.verification.reason.replace("_", " ")}).`
        : "",
    ].filter(Boolean);
    for (const e of evidence) {
      for (const l of wrap(d, e, d.font, 7, RIGHT - MARGIN)) {
        text(d, l, MARGIN, d.y, 7, { color: e.startsWith("WARNING") ? warn : muted });
        d.y -= 9;
      }
    }
  } else {
    d.y -= 50;
    d.page.drawLine({ start: { x: MARGIN, y: d.y }, end: { x: MARGIN + 240, y: d.y }, thickness: 0.6, color: muted });
    d.page.drawLine({ start: { x: MARGIN + 290, y: d.y }, end: { x: RIGHT, y: d.y }, thickness: 0.6, color: muted });
    d.y -= 11;
    text(d, "Signature", MARGIN, d.y, 8, { color: muted });
    text(d, "Name and date", MARGIN + 290, d.y, 8, { color: muted });
    d.y -= 14;
    text(d, "Draft: not signed. Sign it in the app to make it a record.", MARGIN, d.y, 8, { color: warn });
    d.y -= 10;
  }

  if (estimated) {
    d.y -= 8;
    ensureRoom(d, 24);
    for (const l of wrap(
      d,
      "* AI estimate: a value suggested by an AI model from photos of the item, reviewed and accepted by a person. It is an estimate, not an appraisal.",
      d.font,
      7.5,
      RIGHT - MARGIN,
    )) {
      text(d, l, MARGIN, d.y, 7.5, { color: muted });
      d.y -= 10;
    }
  }

  footers(d, `Printed ${printed}`, `${config.appName}  ·  ${decl.code}`);
  return save(d);
}

