/**
 * Manifest CSV: the move plan a facilities team already keeps in a
 * spreadsheet, pasted or uploaded onto a job. Parsing is pure so it can be
 * tested line by line; applying it to a job is in manifest.ts.
 *
 * Two kinds of row are accepted, told apart by whether the code cell is filled:
 *
 *   code,destination,floor,department,desk      one item: add it, set its fields
 *   ,Level 5 / Finance,5,Finance,               every line in department
 *                                               "Finance": set its destination
 *
 * A header row is optional. Without one the columns are read in the order
 * above. Commas, semicolons and tabs all work as the separator, because a
 * spreadsheet saved in a European locale uses semicolons.
 */

export type ManifestCsvRow = {
  /** 1-based line number in the source, for error messages. */
  line: number;
  code: string | null;
  destination: string | null;
  floor: string | null;
  department: string | null;
  desk: string | null;
  crate: string | null;
  notes: string | null;
};

export type ManifestCsvField = Exclude<keyof ManifestCsvRow, "line">;

export type ManifestCsv = {
  rows: ManifestCsvRow[];
  /** Which column each field came from, or null when absent. */
  columns: Record<ManifestCsvField, number | null>;
  hasHeader: boolean;
  errors: { line: number; message: string }[];
};

const ALIASES: Record<ManifestCsvField, string[]> = {
  code: ["code", "asset code", "asset", "tag", "barcode", "item code", "serial", "epc"],
  destination: ["destination", "dest", "to", "destination location", "new location", "room"],
  floor: ["floor", "level", "destination floor"],
  department: ["department", "dept", "team", "division"],
  desk: ["desk", "seat", "destination label", "position", "bay"],
  crate: ["crate", "crate no", "crate number", "crate #", "box", "carton"],
  notes: ["notes", "note", "comment", "comments"],
};

const POSITIONAL: ManifestCsvField[] = ["code", "destination", "floor", "department", "desk", "crate", "notes"];

const normalizeHeader = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ");

/** Pick the separator that splits the first line into the most fields. */
function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    let count = 0;
    let quoted = false;
    for (const ch of first) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count += 1;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * RFC 4180 records: quoted fields may hold separators, doubled quotes and line
 * breaks. Returns each record with the line it started on. Blank lines are
 * skipped.
 */
export function parseCsv(input: string, delimiter?: string): { line: number; cells: string[] }[] {
  const text = input.replace(/^﻿/, "");
  const sep = delimiter ?? detectDelimiter(text);
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;

  const endRecord = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== "")) records.push({ line: startLine, cells });
    cells = [];
    cell = "";
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line += 1;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (ch === sep) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      endRecord();
      line += 1;
      startLine = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || cells.length > 0) endRecord();
  return records;
}

function headerColumns(cells: string[]): Record<ManifestCsvField, number | null> | null {
  const columns = Object.fromEntries(POSITIONAL.map((f) => [f, null])) as Record<ManifestCsvField, number | null>;
  let matched = 0;
  cells.forEach((raw, index) => {
    const h = normalizeHeader(raw);
    for (const field of POSITIONAL) {
      if (columns[field] === null && ALIASES[field].includes(h)) {
        columns[field] = index;
        matched += 1;
        break;
      }
    }
  });
  return matched > 0 ? columns : null;
}

const cellValue = (cells: string[], index: number | null): string | null => {
  if (index === null) return null;
  const v = cells[index]?.trim();
  return v ? v : null;
};

/** Parse a manifest CSV into rows, noting any that cannot be used. */
export function parseManifestCsv(text: string): ManifestCsv {
  const records = parseCsv(text);
  const errors: ManifestCsv["errors"] = [];
  if (records.length === 0) {
    return {
      rows: [],
      columns: Object.fromEntries(POSITIONAL.map((f) => [f, null])) as ManifestCsv["columns"],
      hasHeader: false,
      errors: [{ line: 1, message: "The file is empty." }],
    };
  }

  const fromHeader = headerColumns(records[0]!.cells);
  const columns =
    fromHeader ??
    (Object.fromEntries(POSITIONAL.map((f, i) => [f, i])) as Record<ManifestCsvField, number | null>);
  const body = fromHeader ? records.slice(1) : records;

  const rows: ManifestCsvRow[] = [];
  for (const { line, cells } of body) {
    const row: ManifestCsvRow = {
      line,
      code: cellValue(cells, columns.code),
      destination: cellValue(cells, columns.destination),
      floor: cellValue(cells, columns.floor),
      department: cellValue(cells, columns.department),
      desk: cellValue(cells, columns.desk),
      crate: cellValue(cells, columns.crate),
      notes: cellValue(cells, columns.notes),
    };
    if (!row.code && !row.department) {
      errors.push({
        line,
        message: "Needs a code (to set one item) or a department (to set every line in it).",
      });
      continue;
    }
    if (!row.code && !row.destination && !row.floor && !row.desk && !row.crate && !row.notes) {
      errors.push({ line, message: `Department "${row.department}" has nothing to set.` });
      continue;
    }
    rows.push(row);
  }
  return { rows, columns, hasHeader: Boolean(fromHeader), errors };
}
