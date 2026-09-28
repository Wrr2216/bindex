import ExcelJS from "exceljs";
import { CsvError, decodeText, parseCsv, recordsToTable, type Table } from "./csv";

/**
 * Uploaded register bytes to a header-keyed table, whether they are CSV or
 * XLSX. The format is decided by content, not by the file name, because a
 * browser's idea of a file's type is often wrong.
 */

export const MAX_ROWS = 50_000;

export type RegisterFile = Table & { format: "csv" | "xlsx"; delimiter?: string };

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0];

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b);

export async function readRegisterFile(bytes: Buffer): Promise<RegisterFile> {
  if (bytes.length === 0) throw new CsvError("The file is empty.");
  if (startsWith(bytes, OLE)) {
    throw new CsvError("That is an old-style .xls workbook. Save it as .xlsx or .csv and upload it again.");
  }
  const table = startsWith(bytes, ZIP) ? await readXlsx(bytes) : readCsv(bytes);
  if (table.headers.length === 0) throw new CsvError("The file has no header row.");
  if (table.rows.length === 0) throw new CsvError("The file has a header row but no data rows.");
  if (table.rows.length > MAX_ROWS) {
    throw new CsvError(`The file has ${table.rows.length} rows; the limit is ${MAX_ROWS}. Split it and upload the parts.`);
  }
  return table;
}

function readCsv(bytes: Buffer): RegisterFile {
  const parsed = parseCsv(decodeText(bytes));
  return { ...recordsToTable(parsed.records, parsed.recordNumbers), format: "csv", delimiter: parsed.delimiter };
}

/** An XLSX cell as the text a person sees in it. */
export function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) {
    // Dates without a time of day are written as dates, so they read the same
    // as a date typed into a CSV.
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
    if ("formula" in value || "sharedFormula" in value) {
      return cellText((value as { result?: ExcelJS.CellValue }).result ?? null);
    }
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("error" in value) return "";
  }
  return String(value);
}

async function readXlsx(bytes: Buffer): Promise<RegisterFile> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new CsvError("That file looks like a workbook but could not be opened. Save it again as .xlsx or .csv.");
  }
  // The first sheet with anything on it: exports sometimes lead with a cover
  // sheet that is blank.
  const sheet = wb.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) return { headers: [], rows: [], format: "xlsx" };

  const records: string[][] = [];
  const numbers: number[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    // row.values is 1-based and sparse.
    const values = row.values as ExcelJS.CellValue[];
    for (let c = 1; c < values.length; c++) cells.push(cellText(values[c] ?? null).trim());
    if (cells.some((v) => v !== "")) {
      records.push(cells);
      numbers.push(rowNumber);
    }
  });
  return { ...recordsToTable(records, numbers), format: "xlsx" };
}
