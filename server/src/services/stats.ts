import { pool } from "../db/client";
import { getConfig } from "./config";

export type Breakdown = { name: string; count: number; valueCents: number };

export type Stats = {
  items: number;
  valueCents: number;
  checkedOut: number;
  noLocation: number;
  noValue: number;
  byStatus: { name: string; count: number }[];
  byCategory: { name: string; count: number }[];
  byLocation: Breakdown[];
  byCompany: Breakdown[];
  byEntity: Breakdown[];
  digitalItems: number;
  digitalValueCents: number;
  byDigitalCategory: { name: string; count: number }[];
};

// IS DISTINCT FROM keeps uncategorised items (category IS NULL) in the counts.
const NOT_DOMAIN = "WHERE i.category IS DISTINCT FROM 'Domain'";
const IS_DOMAIN = "WHERE i.category = 'Domain'";

export async function getStats(): Promise<Stats> {
  const [totals, byStatus, byCategory, byLocation, byCompany, byEntity, digitalTotals, byDigitalCategory] =
    await Promise.all([
      pool.query(
        `SELECT count(*)::int AS items,
                coalesce(sum(value_cents),0)::bigint AS value_cents,
                count(*) FILTER (WHERE utilized_by_entity_id IS NOT NULL)::int AS checked_out,
                count(*) FILTER (WHERE location_id IS NULL)::int AS no_location,
                count(*) FILTER (WHERE value_cents IS NULL)::int AS no_value
           FROM items i
          ${NOT_DOMAIN}`,
      ),
      pool.query(
        `SELECT status AS name, count(*)::int AS n
           FROM items i
          ${NOT_DOMAIN}
          GROUP BY status ORDER BY n DESC`,
      ),
      pool.query(
        `SELECT coalesce(category,'Uncategorized') AS name, count(*)::int AS n
           FROM items
          ${NOT_DOMAIN.replace("i.", "")}
          GROUP BY 1 ORDER BY n DESC LIMIT 10`,
      ),
      pool.query(
        `SELECT coalesce(l.name,'Unassigned') AS name, count(*)::int AS n,
                coalesce(sum(i.value_cents),0)::bigint AS value_cents
           FROM items i LEFT JOIN locations l ON l.id = i.location_id
          ${NOT_DOMAIN}
          GROUP BY 1 ORDER BY n DESC`,
      ),
      pool.query(
        `SELECT coalesce(c.name,'Unassigned') AS name, count(*)::int AS n,
                coalesce(sum(i.value_cents),0)::bigint AS value_cents
           FROM items i
           LEFT JOIN locations l ON l.id = i.location_id
           LEFT JOIN companies c ON c.id = l.company_id
          ${NOT_DOMAIN}
          GROUP BY 1 ORDER BY n DESC`,
      ),
      pool.query(
        `SELECT e.name AS name, count(*)::int AS n,
                coalesce(sum(i.value_cents),0)::bigint AS value_cents
           FROM items i JOIN entities e ON e.id = i.utilized_by_entity_id
          ${NOT_DOMAIN}
          GROUP BY 1 ORDER BY n DESC`,
      ),
      pool.query(
        `SELECT count(*)::int AS items,
                coalesce(sum(value_cents),0)::bigint AS value_cents
           FROM items i
          ${IS_DOMAIN}`,
      ),
      pool.query(
        `SELECT coalesce(category,'Uncategorized') AS name, count(*)::int AS n
           FROM items
          ${IS_DOMAIN.replace("i.", "")}
          GROUP BY 1 ORDER BY n DESC LIMIT 10`,
      ),
    ]);

  const t = totals.rows[0];
  const digital = digitalTotals.rows[0];
  const bd = (r: { name: string; n: number; value_cents: string }): Breakdown => ({
    name: r.name,
    count: r.n,
    valueCents: Number(r.value_cents),
  });

  return {
    items: t.items,
    valueCents: Number(t.value_cents),
    checkedOut: t.checked_out,
    noLocation: t.no_location,
    noValue: t.no_value,
    byStatus: byStatus.rows.map((r) => ({ name: r.name, count: r.n })),
    byCategory: byCategory.rows.map((r) => ({ name: r.name, count: r.n })),
    byLocation: byLocation.rows.map(bd),
    byCompany: byCompany.rows.map(bd),
    byEntity: byEntity.rows.map(bd),
    digitalItems: digital.items,
    digitalValueCents: Number(digital.value_cents),
    byDigitalCategory: byDigitalCategory.rows.map((r) => ({ name: r.name, count: r.n })),
  };
}

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Everything, one row per item, with the headers this instance calls things. */
export async function itemsCsv(): Promise<string> {
  const { terms } = await getConfig();
  const { rows } = await pool.query(
    `SELECT i.asset_code, i.name, i.brand, i.model, i.category, i.status, i.quantity,
            i.value_cents, l.name AS location, c.name AS company, e.name AS utilized_by,
            i.ninjaone_asset_id, i.created_at
       FROM items i
       LEFT JOIN locations l ON l.id = i.location_id
       LEFT JOIN companies c ON c.id = l.company_id
       LEFT JOIN entities e ON e.id = i.utilized_by_entity_id
      WHERE i.category IS DISTINCT FROM 'Domain'
      ORDER BY i.name`,
  );
  const headers = [
    "Asset Code", "Name", "Brand", "Model", "Category", "Status", "Quantity",
    "Value", terms.location.singular, terms.group.singular, terms.holder.singular,
    "NinjaOne Asset ID", "Created",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.asset_code, r.name, r.brand, r.model, r.category, r.status, r.quantity,
        r.value_cents == null ? "" : (Number(r.value_cents) / 100).toFixed(2),
        r.location, r.company, r.utilized_by, r.ninjaone_asset_id,
        r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}
