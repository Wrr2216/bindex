/**
 * A small RFC 4180 reader, written for registers exported by spreadsheet
 * programs and asset systems rather than for arbitrary CSV.
 *
 * What it handles, because real exports do all of these: a UTF-8 byte order
 * mark, Windows-1252 files from older Excel, CRLF / LF / lone CR line endings,
 * quoted fields containing delimiters, quotes ("") and line breaks, comma,
 * semicolon or tab delimiters (European Excel writes `;`), and Excel's
 * `sep=;` hint on the first line.
 *
 * It is deliberately lenient about a stray quote inside an unquoted field,
 * which some exporters write, and strict about a quoted field that never
 * closes, which means the file was cut short.
 */

export type CsvDelimiter = "," | ";" | "\t";

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

const CANDIDATES: CsvDelimiter[] = [",", ";", "\t"];

/**
 * Turn uploaded bytes into text. UTF-8 is tried first and strictly, because a
 * Windows-1252 file decoded as UTF-8 does not fail loudly: it silently turns
 * every accented character into a replacement character.
 */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Pick the delimiter by counting candidates outside quotes on the first
 * record. Ties go to the comma, the standard.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(CANDIDATES.map((c) => [c, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === "\n" || ch === "\r") break;
    if (counts.has(ch as CsvDelimiter)) counts.set(ch as CsvDelimiter, counts.get(ch as CsvDelimiter)! + 1);
  }
  let best: CsvDelimiter = ",";
  for (const c of CANDIDATES) if (counts.get(c)! > counts.get(best)!) best = c;
  return best;
}

/**
 * `recordNumbers[i]` is the row a spreadsheet program shows `records[i]` on:
 * blank lines count, and a quoted line break does not start a new row.
 */
export type ParsedCsv = { delimiter: CsvDelimiter; records: string[][]; recordNumbers: number[] };

/**
 * Parse CSV text into records. Blank lines are kept out of the result, because
 * spreadsheet exports often end with several.
 */
export function parseCsv(input: string, delimiter?: CsvDelimiter): ParsedCsv {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  // Excel's hint line names the delimiter and is not data.
  const hint = /^sep=(.)\r?\n?/i.exec(text.slice(0, 8));
  if (hint) {
    const named = hint[1] as CsvDelimiter;
    if (!delimiter && CANDIDATES.includes(named)) delimiter = named;
    text = text.slice(hint[0].length);
  }
  const sep = delimiter ?? detectDelimiter(text);

  const records: string[][] = [];
  const recordNumbers: number[] = [];
  let recordNumber = 0;
  let record: string[] = [];
  let field = "";
  let quoted = false; // inside a quoted section
  let line = 1;
  let quoteLine = 0;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    recordNumber++;
    if (record.some((f) => f.trim() !== "")) {
      records.push(record);
      recordNumbers.push(recordNumber);
    }
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      // Opening quote. Leading spaces before it are dropped, as Excel does.
      field = "";
      quoted = true;
      quoteLine = line;
    } else if (ch === sep) {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      endRecord();
    } else {
      field += ch;
    }
  }
  if (quoted) {
    throw new CsvError(
      `A quoted field that starts on line ${quoteLine} is never closed. The file may have been cut short; export it again.`,
    );
  }
  if (field !== "" || record.length > 0) endRecord();
  return { delimiter: sep, records, recordNumbers };
}

/**
 * Header cells become object keys, so they have to be present and distinct.
 * A blank header gets its column number; a repeated one gets a counter.
 */
export function uniqueHeaders(cells: string[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((cell, i) => {
    const base = cell.replace(/\s+/g, " ").trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export type Table = { headers: string[]; rows: { rowNumber: number; cells: Record<string, string> }[] };

/**
 * Records to a header-keyed table. The first record is the header. A row with
 * more cells than there are headers gets extra "Column N" headers rather than
 * losing data.
 */
export function recordsToTable(records: string[][], rowNumbers?: number[]): Table {
  if (records.length === 0) return { headers: [], rows: [] };
  const width = Math.max(...records.map((r) => r.length));
  const headerCells = [...records[0]!];
  while (headerCells.length < width) headerCells.push("");
  const headers = uniqueHeaders(headerCells);
  const rows = records.slice(1).map((rec, idx) => {
    const cells: Record<string, string> = {};
    headers.forEach((h, c) => {
      const v = (rec[c] ?? "").trim();
      if (v !== "") cells[h] = v;
    });
    return { rowNumber: rowNumbers?.[idx + 1] ?? idx + 2, cells };
  });
  return { headers, rows };
}
