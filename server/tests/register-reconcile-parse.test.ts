import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
// Pure modules: nothing here reads the environment, so static imports are safe.
import {
  CsvError,
  decodeText,
  detectDelimiter,
  parseCsv,
  recordsToTable,
  uniqueHeaders,
} from "../src/services/register-reconcile/csv";
import { readRegisterFile } from "../src/services/register-reconcile/file";
import {
  normalizeEpc,
  normalizeLocationText,
  normKey,
  parseCost,
  parseDate,
  parseQuantity,
} from "../src/services/register-reconcile/normalize";

describe("parseCsv", () => {
  it("reads a plain comma-separated file", () => {
    const { records, delimiter } = parseCsv("a,b,c\n1,2,3\n");
    assert.equal(delimiter, ",");
    assert.deepEqual(records, [["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("strips a UTF-8 byte order mark", () => {
    const { records } = parseCsv("﻿Asset Tag,Name\nA1,Laptop");
    assert.equal(records[0]![0], "Asset Tag");
  });

  it("keeps delimiters, escaped quotes and line breaks inside quoted fields", () => {
    const text = 'name,notes\r\n"Desk, oak","Says ""fragile""\r\nsecond line"\r\nChair,plain\r\n';
    const { records, recordNumbers } = parseCsv(text);
    assert.deepEqual(records, [
      ["name", "notes"],
      ["Desk, oak", 'Says "fragile"\r\nsecond line'],
      ["Chair", "plain"],
    ]);
    // A quoted line break does not start a new spreadsheet row.
    assert.deepEqual(recordNumbers, [1, 2, 3]);
  });

  it("detects a semicolon delimiter, as European Excel writes", () => {
    const { records, delimiter } = parseCsv("Tag;Cost\nA1;1.299,00\n");
    assert.equal(delimiter, ";");
    assert.deepEqual(records[1], ["A1", "1.299,00"]);
  });

  it("ignores delimiters inside quotes when detecting", () => {
    assert.equal(detectDelimiter('"a;b;c",d\n'), ",");
    assert.equal(detectDelimiter("a\tb\tc\n"), "\t");
  });

  it("honours Excel's sep= hint line", () => {
    const { records, delimiter } = parseCsv("sep=;\nA,B;C\n1;2\n");
    assert.equal(delimiter, ";");
    assert.deepEqual(records[0], ["A,B", "C"]);
  });

  it("handles lone CR line endings and a missing final newline", () => {
    const { records } = parseCsv("a,b\r1,2\r3,4");
    assert.deepEqual(records, [["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("drops blank lines but keeps counting them as rows", () => {
    const { records, recordNumbers } = parseCsv("a,b\n\n1,2\n,\n3,4\n\n\n");
    assert.deepEqual(records, [["a", "b"], ["1", "2"], ["3", "4"]]);
    assert.deepEqual(recordNumbers, [1, 3, 5]);
  });

  it("keeps an empty quoted field and a stray quote in an unquoted one", () => {
    const { records } = parseCsv('a,b,c\n"",5" monitor,x\n');
    assert.deepEqual(records[1], ["", '5" monitor', "x"]);
  });

  it("refuses a quoted field that never closes, naming the line", () => {
    assert.throws(() => parseCsv('a,b\n1,"open\n2,3\n'), (err: unknown) => {
      assert.ok(err instanceof CsvError);
      assert.match((err as Error).message, /line 2/);
      return true;
    });
  });
});

describe("decodeText", () => {
  it("decodes UTF-8 and drops the BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("Café")]);
    assert.equal(decodeText(bytes), "Café");
  });

  it("falls back to Windows-1252 for files older Excel wrote", () => {
    const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]); // "Café €"
    assert.equal(decodeText(bytes), "Café €");
  });
});

describe("headers and tables", () => {
  it("names blank headers and numbers repeated ones", () => {
    assert.deepEqual(uniqueHeaders(["Name", "", "name", " Serial  No "]), ["Name", "Column 2", "name (2)", "Serial No"]);
  });

  it("widens the header for rows with extra cells and uses spreadsheet row numbers", () => {
    const table = recordsToTable([["a"], ["1", "2"]], [1, 4]);
    assert.deepEqual(table.headers, ["a", "Column 2"]);
    assert.deepEqual(table.rows, [{ rowNumber: 4, cells: { a: "1", "Column 2": "2" } }]);
  });
});

describe("readRegisterFile", () => {
  it("reads an XLSX workbook: dates, rich text, formulas and a blank cover sheet", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Cover");
    const ws = wb.addWorksheet("Assets");
    ws.addRow(["Asset Number", "Description", "Acquisition Date", "Acquisition Cost"]);
    ws.addRow(["FA-1", { richText: [{ text: "Fork" }, { text: "lift" }] }, new Date(Date.UTC(2021, 2, 4)), 25000]);
    ws.addRow([]);
    ws.addRow(["FA-2", "Pallet jack", "2020-01-01", { formula: "100*2", result: 200 }]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const table = await readRegisterFile(bytes);
    assert.equal(table.format, "xlsx");
    assert.deepEqual(table.headers, ["Asset Number", "Description", "Acquisition Date", "Acquisition Cost"]);
    assert.deepEqual(table.rows[0], {
      rowNumber: 2,
      cells: { "Asset Number": "FA-1", Description: "Forklift", "Acquisition Date": "2021-03-04", "Acquisition Cost": "25000" },
    });
    assert.equal(table.rows[1]!.rowNumber, 4);
    assert.equal(table.rows[1]!.cells["Acquisition Cost"], "200");
  });

  it("reads CSV bytes and rejects old .xls and empty files with a way forward", async () => {
    const table = await readRegisterFile(Buffer.from("Tag,Name\nA1,Laptop\n"));
    assert.equal(table.format, "csv");
    assert.equal(table.rows.length, 1);
    await assert.rejects(readRegisterFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0])), /\.xlsx or \.csv/);
    await assert.rejects(readRegisterFile(Buffer.from("Tag,Name\n")), /no data rows/);
    await assert.rejects(readRegisterFile(Buffer.alloc(0)), /empty/);
  });
});

describe("normalize", () => {
  it("compares keys by case and outer space only", () => {
    assert.equal(normKey("  ab-12  "), "AB-12");
    assert.equal(normKey("   "), null);
  });

  it("normalises EPC hex and leaves non-hex tag numbers readable", () => {
    assert.equal(normalizeEpc("e2 80:68-94 0000"), "E2806894" + "0000");
    assert.equal(normalizeEpc("0xE280"), "E280");
    assert.equal(normalizeEpc("tag #12"), "TAG #12");
  });

  it("treats every path separator alike", () => {
    assert.equal(normalizeLocationText(" Warehouse >  Aisle 3 "), "warehouse / aisle 3");
    assert.equal(normalizeLocationText("HQ\\Floor 2|Room 201"), "hq / floor 2 / room 201");
    assert.equal(normalizeLocationText(" / "), null);
  });

  it("parses costs in the shapes registers write them", () => {
    const cents = (v: string) => parseCost(v).value;
    assert.equal(cents("1299"), 129900);
    assert.equal(cents("$1,299.50"), 129950);
    assert.equal(cents("1.299,50 €"), 129950);
    assert.equal(cents("12,5"), 1250);
    assert.equal(cents("1,234"), 123400);
    assert.equal(cents("1.234.567"), 123456700);
    assert.equal(cents("(45.10)"), -4510);
    assert.equal(cents("USD 12"), 1200);
    assert.equal(cents(""), null);
    assert.match(parseCost("n/a").issue ?? "", /not an amount/);
  });

  it("parses dates, including Excel serials and ambiguous numeric dates", () => {
    const d = (v: string, dayFirst = false) => parseDate(v, dayFirst).value;
    assert.equal(d("2023-04-01"), "2023-04-01");
    assert.equal(d("2023-04-01 13:45:00"), "2023-04-01");
    assert.equal(d("04/01/2023"), "2023-04-01");
    assert.equal(d("04/01/2023", true), "2023-01-04");
    assert.equal(d("25/12/2022"), "2022-12-25"); // 25 can only be a day
    assert.equal(d("01.02.23", true), "2023-02-01");
    assert.equal(d("12 Mar 2023"), "2023-03-12");
    assert.equal(d("September 3, 2021"), "2021-09-03");
    assert.equal(d("44927"), "2023-01-01");
    assert.equal(parseDate(new Date(Date.UTC(2020, 1, 29))).value, "2020-02-29");
    assert.equal(d("2023-02-30"), null);
    assert.match(parseDate("soon").issue ?? "", /not a date/);
  });

  it("parses quantities and rejects fractions", () => {
    assert.equal(parseQuantity("1,200").value, 1200);
    assert.equal(parseQuantity("2.5").value, null);
    assert.ok(parseQuantity("2.5").issue);
  });
});
