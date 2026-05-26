import ExcelJS from "exceljs";

/**
 * One row per label, for label software that imports a spreadsheet as its data
 * source rather than printing a PDF.
 */
export type LabelSheetRow = {
  assetCode: string;
  itemName: string;
  subLine: string;
  serials: string;
  location: string;
  url: string;
};

const HEADERS = ["Asset Code", "Item Name", "Sub Line", "Serial Numbers", "Location", "URL"];

export async function generateLabelSheet(rows: LabelSheetRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Labels");

  ws.columns = HEADERS.map((h) => ({
    header: h,
    key: h,
    width: h === "Item Name" || h === "URL" ? 40 : h === "Sub Line" || h === "Serial Numbers" ? 30 : 20,
  }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };

  for (const r of rows) {
    ws.addRow([r.assetCode, r.itemName, r.subLine, r.serials, r.location, r.url]);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
