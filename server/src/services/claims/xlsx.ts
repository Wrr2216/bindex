import ExcelJS from "exceljs";

/**
 * A claim as a workbook, for adjusters and finance teams who work in
 * spreadsheets: a summary, one row per line with its amounts as numbers, the
 * evidence on file with links, the timeline and the audit-log ids.
 */

export type ClaimSheet = {
  title: string;
  subtitle: string;
  currency: string;
  summary: [string, string | number | null][];
  lines: {
    index: number;
    item: string;
    code: string;
    description: string | null;
    damage: string | null;
    stage: string | null;
    resolution: string | null;
    declaredCents: number | null;
    estimatedCents: number | null;
    approvedCents: number | null;
    photos: number;
    packedAt: string | null;
    deliveredAt: string | null;
    conditionNotes: string | null;
  }[];
  evidence: { line: string; kind: string; at: string | null; phase: string | null; detail: string; url: string | null }[];
  timeline: { at: string; what: string; detail: string | null }[];
  audit: { line: string; id: number; type: string; at: string; hash: string }[];
};

const MONEY = "#,##0.00";
const cents = (v: number | null) => (v === null ? null : v / 100);

function sheet(wb: ExcelJS.Workbook, name: string, columns: { header: string; key: string; width: number }[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

export async function renderClaimXlsx(s: ClaimSheet): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { key: "label", width: 26 },
    { key: "value", width: 70 },
  ];
  summary.getCell("A1").value = s.title;
  summary.getCell("A1").font = { bold: true, size: 14 };
  summary.getCell("A2").value = s.subtitle;
  summary.getCell("A2").font = { color: { argb: "FF6B7280" } };
  summary.addRow([]);
  for (const [label, value] of s.summary) {
    const row = summary.addRow([label, value ?? ""]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    if (typeof value === "number") row.getCell(2).numFmt = MONEY;
  }

  const lines = sheet(wb, "Lines", [
    { header: "#", key: "index", width: 5 },
    { header: "Item", key: "item", width: 32 },
    { header: "Code", key: "code", width: 14 },
    { header: "Description", key: "description", width: 30 },
    { header: "Damage", key: "damage", width: 36 },
    { header: "Stage", key: "stage", width: 12 },
    { header: "Resolution", key: "resolution", width: 16 },
    { header: `Declared (${s.currency})`, key: "declared", width: 14 },
    { header: `Estimated (${s.currency})`, key: "estimated", width: 14 },
    { header: `Approved (${s.currency})`, key: "approved", width: 14 },
    { header: "Photos", key: "photos", width: 8 },
    { header: "Packed", key: "packedAt", width: 20 },
    { header: "Delivered", key: "deliveredAt", width: 20 },
    { header: "Condition notes", key: "conditionNotes", width: 60 },
  ]);
  for (const l of s.lines) {
    const row = lines.addRow({
      ...l,
      declared: cents(l.declaredCents),
      estimated: cents(l.estimatedCents),
      approved: cents(l.approvedCents),
    });
    for (const key of ["declared", "estimated", "approved"]) row.getCell(key).numFmt = MONEY;
    row.getCell("conditionNotes").alignment = { wrapText: true, vertical: "top" };
    row.getCell("damage").alignment = { wrapText: true, vertical: "top" };
  }
  if (s.lines.length) {
    const first = 2;
    const last = s.lines.length + 1;
    const total = lines.addRow({ item: "Total" });
    total.font = { bold: true };
    for (const [key, col] of [
      ["estimated", "I"],
      ["approved", "J"],
    ] as const) {
      total.getCell(key).value = { formula: `SUM(${col}${first}:${col}${last})` };
      total.getCell(key).numFmt = MONEY;
    }
  }

  const evidence = sheet(wb, "Evidence", [
    { header: "Line", key: "line", width: 30 },
    { header: "Kind", key: "kind", width: 16 },
    { header: "When", key: "at", width: 22 },
    { header: "Before / after", key: "phase", width: 14 },
    { header: "Detail", key: "detail", width: 70 },
    { header: "Link", key: "url", width: 50 },
  ]);
  for (const e of s.evidence) {
    const row = evidence.addRow({ ...e, url: null });
    if (e.url) row.getCell("url").value = { text: e.url, hyperlink: e.url };
    row.getCell("detail").alignment = { wrapText: true, vertical: "top" };
  }

  const timeline = sheet(wb, "Timeline", [
    { header: "When", key: "at", width: 22 },
    { header: "What", key: "what", width: 40 },
    { header: "Detail", key: "detail", width: 70 },
  ]);
  for (const t of s.timeline) timeline.addRow(t);

  const audit = sheet(wb, "Audit log", [
    { header: "Line", key: "line", width: 30 },
    { header: "Entry", key: "id", width: 10 },
    { header: "Event", key: "type", width: 26 },
    { header: "When", key: "at", width: 24 },
    { header: "Hash", key: "hash", width: 70 },
  ]);
  for (const a of s.audit) audit.addRow(a);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
