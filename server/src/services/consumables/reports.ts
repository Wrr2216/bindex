import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { badRequest } from "../../lib/errors";
import { toQty } from "./ledger";
import { listMovements } from "./stock";

/**
 * Usage over a date range, by holder and by item.
 *
 * "Used" is what left the shelves and did not come back: issued minus
 * returned, plus anything recorded as used straight from a location.
 * Consumption recorded out of a holder's issued stock is already inside
 * issued minus returned, so it is shown but not added again. Cost uses the
 * per-unit cost captured on each movement, so repricing an item later does
 * not rewrite what past jobs cost.
 */

export type UsageRange = { from: Date; to: Date };

// A movement's contribution to "used", and the cost of that contribution.
const USED = sql`CASE
  WHEN m.reason = 'issue' THEN m.qty
  WHEN m.reason = 'return' THEN -m.qty
  WHEN m.reason = 'consume' AND m.holder_delta = 0 THEN m.qty
  ELSE 0 END`;
const COST = sql`coalesce(m.unit_cost_cents, i.value_cents, 0)`;

type Totals = {
  issued: string | null;
  returned: string | null;
  consumed: string | null;
  used: string | null;
  cost: string | null;
};

const totals = (r: Totals) => ({
  issued: toQty(r.issued),
  returned: toQty(r.returned),
  consumed: toQty(r.consumed),
  used: toQty(r.used),
  costCents: Math.round(Number(r.cost ?? 0)),
});

function checkRange({ from, to }: UsageRange) {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw badRequest("Give the report a start and end date.");
  }
  if (from >= to) throw badRequest("The report has to end after it starts.");
}

export async function usageReport(range: UsageRange) {
  checkRange(range);
  const { from, to } = range;
  const [byHolder, byItem] = await Promise.all([
    db.execute<
      Totals & { holder_id: string | null; holder_name: string; item_id: string; item_name: string; unit: string | null }
    >(sql`
      SELECT m.holder_entity_id AS holder_id, m.holder_name, m.item_id, i.name AS item_name, c.unit,
             sum(m.qty) FILTER (WHERE m.reason = 'issue') AS issued,
             sum(m.qty) FILTER (WHERE m.reason = 'return') AS returned,
             sum(m.qty) FILTER (WHERE m.reason = 'consume') AS consumed,
             sum(${USED}) AS used,
             sum(${USED} * ${COST}) AS cost
        FROM stock_movements m
        JOIN items i ON i.id = m.item_id
        LEFT JOIN consumable_items c ON c.item_id = m.item_id
       WHERE m.holder_name IS NOT NULL AND m.created_at >= ${from} AND m.created_at < ${to}
       GROUP BY m.holder_entity_id, m.holder_name, m.item_id, i.name, c.unit
       ORDER BY m.holder_name, i.name`),
    db.execute<
      Totals & {
        item_id: string;
        item_name: string;
        unit: string | null;
        value_cents: string | null;
        received: string | null;
        shrinkage: string | null;
      }
    >(sql`
      SELECT m.item_id, i.name AS item_name, c.unit, i.value_cents,
             sum(m.qty) FILTER (WHERE m.reason = 'receive') AS received,
             sum(m.qty) FILTER (WHERE m.reason = 'issue') AS issued,
             sum(m.qty) FILTER (WHERE m.reason = 'return') AS returned,
             sum(m.qty) FILTER (WHERE m.reason = 'consume') AS consumed,
             sum(${USED}) AS used,
             sum(${USED} * ${COST}) AS cost,
             -- Stock that a count or an adjustment found missing, net of any found extra.
             sum(CASE WHEN m.reason IN ('count', 'adjust') THEN
                   CASE WHEN m.from_location_id IS NOT NULL THEN m.qty
                        WHEN m.to_location_id IS NOT NULL THEN -m.qty ELSE 0 END
                 ELSE 0 END) AS shrinkage
        FROM stock_movements m
        JOIN items i ON i.id = m.item_id
        LEFT JOIN consumable_items c ON c.item_id = m.item_id
       WHERE m.created_at >= ${from} AND m.created_at < ${to}
       GROUP BY m.item_id, i.name, c.unit, i.value_cents
       ORDER BY i.name`),
  ]);

  const holderRows = byHolder.rows.map((r) => ({
    holderId: r.holder_id,
    holderName: r.holder_name,
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit ?? "each",
    ...totals(r),
  }));
  const itemRows = byItem.rows.map((r) => ({
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit ?? "each",
    unitCostCents: r.value_cents === null ? null : Number(r.value_cents),
    received: toQty(r.received),
    shrinkage: toQty(r.shrinkage),
    ...totals(r),
  }));

  // One line per holder for the summary table on screen.
  const holders = new Map<string, { holderId: string | null; holderName: string; costCents: number; lines: number }>();
  for (const r of holderRows) {
    const k = r.holderId ?? `name:${r.holderName}`;
    const h = holders.get(k) ?? { holderId: r.holderId, holderName: r.holderName, costCents: 0, lines: 0 };
    h.costCents += r.costCents;
    h.lines += 1;
    holders.set(k, h);
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    byHolder: holderRows,
    holderTotals: [...holders.values()],
    byItem: itemRows,
    totalCostCents: itemRows.reduce((n, r) => n + r.costCents, 0),
  };
}

export type UsageReport = Awaited<ReturnType<typeof usageReport>>;

const MOVEMENT_SHEET_LIMIT = 5000;

/** The same report as a workbook: one sheet per view, plus the raw movements. */
export async function usageWorkbook(range: UsageRange, currency: string): Promise<Buffer> {
  const report = await usageReport(range);
  const movements = await listMovements({ from: range.from, to: range.to, limit: MOVEMENT_SHEET_LIMIT });
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const money = `#,##0.00 "${currency}"`;
  const qty = "#,##0.###";

  const sheet = (name: string, cols: { header: string; key: string; width: number; fmt?: string }[]) => {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.fmt ? { numFmt: c.fmt } : {} }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    return ws;
  };

  const byHolder = sheet("By holder", [
    { header: "Holder", key: "holder", width: 24 },
    { header: "Item", key: "item", width: 32 },
    { header: "Unit", key: "unit", width: 10 },
    { header: "Issued", key: "issued", width: 10, fmt: qty },
    { header: "Returned", key: "returned", width: 10, fmt: qty },
    { header: "Consumed", key: "consumed", width: 10, fmt: qty },
    { header: "Used", key: "used", width: 10, fmt: qty },
    { header: "Cost", key: "cost", width: 14, fmt: money },
  ]);
  for (const r of report.byHolder) {
    byHolder.addRow({
      holder: r.holderName,
      item: r.itemName,
      unit: r.unit,
      issued: r.issued,
      returned: r.returned,
      consumed: r.consumed,
      used: r.used,
      cost: r.costCents / 100,
    });
  }

  const byItem = sheet("By item", [
    { header: "Item", key: "item", width: 32 },
    { header: "Unit", key: "unit", width: 10 },
    { header: "Received", key: "received", width: 10, fmt: qty },
    { header: "Issued", key: "issued", width: 10, fmt: qty },
    { header: "Returned", key: "returned", width: 10, fmt: qty },
    { header: "Consumed", key: "consumed", width: 10, fmt: qty },
    { header: "Used", key: "used", width: 10, fmt: qty },
    { header: "Shrinkage", key: "shrinkage", width: 10, fmt: qty },
    { header: "Unit cost", key: "unitCost", width: 12, fmt: money },
    { header: "Cost of used", key: "cost", width: 14, fmt: money },
  ]);
  for (const r of report.byItem) {
    byItem.addRow({
      item: r.itemName,
      unit: r.unit,
      received: r.received,
      issued: r.issued,
      returned: r.returned,
      consumed: r.consumed,
      used: r.used,
      shrinkage: r.shrinkage,
      unitCost: r.unitCostCents === null ? null : r.unitCostCents / 100,
      cost: r.costCents / 100,
    });
  }
  const total = byItem.addRow({ item: "Total", cost: report.totalCostCents / 100 });
  total.font = { bold: true };

  const log = sheet("Movements", [
    { header: "When", key: "when", width: 20, fmt: "yyyy-mm-dd hh:mm" },
    { header: "Reason", key: "reason", width: 10 },
    { header: "Item", key: "item", width: 32 },
    { header: "Quantity", key: "qty", width: 10, fmt: qty },
    { header: "Unit", key: "unit", width: 10 },
    { header: "From", key: "from", width: 20 },
    { header: "To", key: "to", width: 20 },
    { header: "Holder", key: "holder", width: 20 },
    { header: "Job", key: "job", width: 16 },
    { header: "Note", key: "note", width: 30 },
    { header: "By", key: "by", width: 20 },
  ]);
  for (const m of movements) {
    log.addRow({
      when: new Date(m.createdAt),
      reason: m.reason,
      item: m.itemName,
      qty: m.qty,
      unit: m.unit,
      from: m.fromLocationName ?? "",
      to: m.toLocationName ?? "",
      holder: m.holderName ?? "",
      job: m.jobRef ?? "",
      note: m.note ?? "",
      by: m.createdByName ?? m.createdBy ?? "",
    });
  }
  if (movements.length === MOVEMENT_SHEET_LIMIT) {
    log.addRow({ item: `Only the latest ${MOVEMENT_SHEET_LIMIT} movements are listed; narrow the dates for the rest.` });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
