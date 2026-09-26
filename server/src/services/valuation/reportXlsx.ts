import ExcelJS from "exceljs";
import { thumbFor } from "./photos";
import type { Report } from "./report";

/**
 * The valuation report as a workbook: one row per record with every figure as
 * a number (so it sums and filters), a small photo in the first column, and a
 * summary sheet by group. Same data as the PDF.
 */

const MAX_PHOTOS = 400;
const PHOTO_PX = 56;

/** Cells a spreadsheet would run as a formula are prefixed, as the audit-log CSV export does. */
const cell = (s: string | null | undefined): string => {
  const v = s ?? "";
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
};

export async function reportXlsx(report: Report, baseUrl: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = report.appName;
  wb.created = report.generatedAt;
  const money = `#,##0.00 "${report.currency}"`;

  const ws = wb.addWorksheet("Records", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Photo", key: "photo", width: 10 },
    { header: "Group", key: "group", width: 22 },
    { header: "Location", key: "location", width: 22 },
    { header: "Company", key: "company", width: 18 },
    { header: "Asset code", key: "code", width: 14 },
    { header: "Name", key: "name", width: 32 },
    { header: "Unit", key: "unit", width: 14 },
    { header: "Brand", key: "brand", width: 14 },
    { header: "Model", key: "model", width: 16 },
    { header: "Category", key: "category", width: 14 },
    { header: "Serial numbers", key: "serials", width: 22 },
    { header: "Status", key: "status", width: 10 },
    { header: "Qty", key: "qty", width: 6 },
    { header: "Condition", key: "condition", width: 12 },
    { header: "Materials", key: "materials", width: 18 },
    { header: "Purchase date", key: "purchaseDate", width: 13 },
    { header: "Vendor", key: "vendor", width: 18 },
    { header: "Purchase price", key: "cost", width: 15, style: { numFmt: money } },
    { header: "Value", key: "value", width: 15, style: { numFmt: money } },
    { header: "Valued on", key: "valuedOn", width: 12 },
    { header: "Value source", key: "source", width: 12 },
    { header: "AI confidence", key: "confidence", width: 12, style: { numFmt: "0%" } },
    { header: "Useful life (years)", key: "life", width: 10 },
    { header: "Age (years)", key: "age", width: 10 },
    { header: "Book value", key: "book", width: 15, style: { numFmt: money } },
    { header: "High value", key: "highValue", width: 10 },
    { header: "Warranty ends", key: "warranty", width: 13 },
    { header: "Link", key: "link", width: 40 },
  ];
  ws.getRow(1).font = { bold: true };

  let photos = 0;
  for (const g of report.groups) {
    for (const r of g.rows) {
      const url = `${baseUrl}/items/${r.itemId}${r.unitId ? `?unit=${r.unitId}` : ""}`;
      const row = ws.addRow({
        group: cell(g.name),
        location: cell(r.locationName),
        company: cell(r.companyName),
        code: cell(r.assetCode),
        name: cell(r.name),
        unit: cell(r.unitLabel),
        brand: cell(r.brand),
        model: cell(r.model),
        category: cell(r.category),
        serials: cell(r.serials.join(", ")),
        status: cell(r.status),
        qty: r.quantity,
        condition: cell(r.condition),
        materials: cell(r.materials),
        purchaseDate: r.purchaseDate ?? "",
        vendor: cell(r.vendor),
        cost: r.purchaseCents === null ? null : r.purchaseCents / 100,
        value: r.valueCents === null ? null : r.valueCents / 100,
        valuedOn: r.lastValuedOn ?? "",
        source: r.lastSource === "ai" ? "AI estimate" : (r.lastSource ?? ""),
        confidence: r.lastSource === "ai" && r.lastConfidence !== null ? r.lastConfidence : null,
        life: r.lifeYears,
        age: r.depreciation?.ageYears ?? null,
        book: r.depreciation ? r.depreciation.bookCents / 100 : null,
        highValue: r.highValue ? "Yes" : "",
        warranty: r.warrantyEnds ?? "",
        link: { text: url, hyperlink: url },
      });
      row.alignment = { vertical: "top", wrapText: true };
      if (photos < MAX_PHOTOS) {
        const jpeg = await thumbFor({ id: r.itemId, primaryImageUrl: r.primaryImageUrl }, r.unitId, 120);
        if (jpeg) {
          const imageId = wb.addImage({ buffer: jpeg as unknown as ExcelJS.Buffer, extension: "jpeg" });
          ws.addImage(imageId, { tl: { col: 0.1, row: row.number - 1 + 0.1 }, ext: { width: PHOTO_PX, height: PHOTO_PX } });
          row.height = PHOTO_PX * 0.78;
          photos++;
        }
      }
    }
  }
  ws.autoFilter = { from: { row: 1, column: 2 }, to: { row: 1, column: ws.columns.length } };

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Group", key: "group", width: 30 },
    { header: "Records", key: "records", width: 10 },
    { header: "Value", key: "value", width: 16, style: { numFmt: money } },
    { header: "Purchase cost", key: "cost", width: 16, style: { numFmt: money } },
    { header: "Book value", key: "book", width: 16, style: { numFmt: money } },
  ];
  summary.getRow(1).font = { bold: true };
  for (const g of report.groups) {
    summary.addRow({ group: cell(g.name), records: g.rows.length, value: g.valueCents / 100, cost: g.costCents / 100, book: g.bookCents / 100 });
  }
  const total = summary.addRow({
    group: "Total",
    records: report.totals.records,
    value: report.totals.valueCents / 100,
    cost: report.totals.costCents / 100,
    book: report.totals.bookCents / 100,
  });
  total.font = { bold: true };
  summary.addRow({});
  for (const line of [
    `${report.title}: ${report.scope}`,
    `Values as of ${report.asOf}, in ${report.currency}. High value: at or over ${(report.thresholdCents / 100).toFixed(2)}.`,
    "Book value is straight-line depreciation from the purchase date over each category's useful life; without a purchase price it runs from the recorded value.",
    "AI estimate: a value suggested by an AI model from photos and confirmed by a person. It is an estimate, not an appraisal.",
  ]) {
    summary.addRow({ group: cell(line) });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
