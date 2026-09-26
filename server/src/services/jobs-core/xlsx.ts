import ExcelJS from "exceljs";

/**
 * The manifest as a spreadsheet, for the facilities team that plans moves in
 * Excel: one row per line, grouped with a bold heading row per floor or
 * department, a tick in each step column the line has reached, and filters on
 * the header.
 */

export type ManifestSheetRow = {
  group: string | null;
  index: number;
  itemName: string;
  brandModel: string | null;
  assetCode: string;
  unit: string | null;
  serial: string | null;
  crate: string | null;
  origin: string | null;
  destination: string | null;
  desk: string | null;
  floor: string | null;
  department: string | null;
  shipment: string | null;
  stage: string;
  packed: boolean;
  loaded: boolean;
  delivered: boolean;
  placed: boolean;
  notes: string | null;
};

const COLUMNS: { header: string; key: keyof ManifestSheetRow; width: number }[] = [
  { header: "#", key: "index", width: 6 },
  { header: "Item", key: "itemName", width: 34 },
  { header: "Brand / model", key: "brandModel", width: 24 },
  { header: "Asset code", key: "assetCode", width: 14 },
  { header: "Unit", key: "unit", width: 14 },
  { header: "Serial", key: "serial", width: 18 },
  { header: "Crate", key: "crate", width: 10 },
  { header: "From", key: "origin", width: 28 },
  { header: "Destination", key: "destination", width: 30 },
  { header: "Desk / room", key: "desk", width: 14 },
  { header: "Floor", key: "floor", width: 10 },
  { header: "Department", key: "department", width: 18 },
  { header: "Shipment", key: "shipment", width: 14 },
  { header: "Stage", key: "stage", width: 14 },
  { header: "Packed", key: "packed", width: 8 },
  { header: "Loaded", key: "loaded", width: 8 },
  { header: "Delivered", key: "delivered", width: 10 },
  { header: "Placed", key: "placed", width: 8 },
  { header: "Notes", key: "notes", width: 30 },
];

export async function renderManifestXlsx(
  title: string,
  subtitle: string,
  rows: ManifestSheetRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Manifest", { views: [{ state: "frozen", ySplit: 3 }] });
  ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

  ws.getCell("A1").value = title;
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.getCell("A2").value = subtitle;
  ws.getCell("A2").font = { color: { argb: "FF6B7280" } };

  const header = ws.getRow(3);
  COLUMNS.forEach((c, i) => {
    header.getCell(i + 1).value = c.header;
  });
  header.font = { bold: true };
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: COLUMNS.length } };

  let group: string | null | undefined;
  for (const r of rows) {
    if (r.group !== null && r.group !== group) {
      const g = ws.addRow([r.group]);
      g.font = { bold: true };
      g.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF1F5" } };
    }
    group = r.group;
    ws.addRow(
      COLUMNS.map((c) => {
        const v = r[c.key];
        if (typeof v === "boolean") return v ? "✓" : "";
        return v ?? "";
      }),
    );
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
