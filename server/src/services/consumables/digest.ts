import { formatQty } from "./ledger";

/**
 * The parts of the daily low-stock digest that do not touch the database or
 * the network: which day it is, whether it is time yet, and what the message
 * says.
 */

export type LowStockRow = {
  itemId: string;
  itemName: string;
  unit: string;
  /** Null when the item is not stocked at any location at all. */
  locationId: string | null;
  locationName: string | null;
  qty: number;
  reorderPoint: number;
  reorderQty: number | null;
  supplier: string | null;
};

/** Calendar day in the server's own time zone, which is what "daily" means to whoever runs it. */
export function dayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The digest goes out on the first check at or after the configured hour. */
export function isDue(now: Date, hour: number): boolean {
  return hour >= 0 && hour <= 23 && now.getHours() >= hour;
}

// Pushover caps a message at 1024 characters; leave room for the tail line.
const MESSAGE_BUDGET = 960;
const NOWHERE = "Not stocked anywhere";

function describe(r: LowStockRow): string {
  const order = r.reorderQty ? `, order ${formatQty(r.reorderQty)}` : "";
  const from = r.supplier ? ` from ${r.supplier}` : "";
  return `- ${r.itemName}: ${formatQty(r.qty)} ${r.unit} (reorder at ${formatQty(r.reorderPoint)}${order}${from})`;
}

/** One message listing what is low, grouped by location, cut to fit a push notification. */
export function formatDigest(rows: LowStockRow[]): { title: string; message: string } {
  const groups = new Map<string, LowStockRow[]>();
  for (const r of rows) {
    const name = r.locationName ?? NOWHERE;
    const list = groups.get(name) ?? [];
    list.push(r);
    groups.set(name, list);
  }
  // Named locations alphabetically, then the items stocked nowhere.
  const names = [...groups.keys()].sort((a, b) =>
    a === NOWHERE ? 1 : b === NOWHERE ? -1 : a.localeCompare(b),
  );

  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  let budgetHit = false;
  for (const name of names) {
    const list = groups.get(name)!.sort((a, b) => a.itemName.localeCompare(b.itemName));
    for (let i = 0; i < list.length && !budgetHit; i++) {
      const add = i === 0 ? [name, describe(list[i]!)] : [describe(list[i]!)];
      const cost = add.reduce((n, l) => n + l.length + 1, 0);
      if (used + cost > MESSAGE_BUDGET) {
        budgetHit = true;
        break;
      }
      lines.push(...add);
      used += cost;
      shown += 1;
    }
    if (budgetHit) break;
  }
  const rest = rows.length - shown;
  if (rest > 0) lines.push(`…and ${rest} more. Open Supplies for the full list.`);

  const locations = new Set(rows.filter((r) => r.locationId).map((r) => r.locationId)).size;
  const items = new Set(rows.map((r) => r.itemId)).size;
  const where = locations > 1 ? ` across ${locations} locations` : "";
  return {
    title: `${items} suppl${items === 1 ? "y" : "ies"} low${where}`,
    message: lines.join("\n"),
  };
}
