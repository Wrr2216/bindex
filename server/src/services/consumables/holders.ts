import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { entities } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { HOLDER_KINDS } from "./ledger";
import { holderBalances, listMovements } from "./stock";
import { holderEquipment } from "./kits";

/**
 * Crews, trucks and branches are entities with one of the holder kinds. Any
 * other entity that has supplies or equipment out is listed too, so nothing
 * outstanding is hidden by how its holder happens to be classified.
 */
export async function listHolders() {
  const kinds = sql.join(HOLDER_KINDS.map((k) => sql`${k}`), sql`, `);
  const res = await db.execute<{
    id: string;
    name: string;
    kind: string | null;
    equipment_out: string;
    overdue: string;
    supplies_out: string;
  }>(sql`
    WITH eq AS (
      SELECT a.entity_id,
             count(*) AS equipment_out,
             count(*) FILTER (WHERE k.expected_return_at < now()) AS overdue
        FROM item_assignments a
        LEFT JOIN equipment_kit_lines l ON l.assignment_id = a.id
        LEFT JOIN equipment_kits k ON k.id = l.kit_id
       WHERE a.checked_in_at IS NULL AND a.entity_id IS NOT NULL
       GROUP BY a.entity_id
    ), sup AS (
      SELECT holder_entity_id AS entity_id, count(*) AS supplies_out FROM (
        SELECT holder_entity_id, item_id FROM stock_movements
         WHERE holder_entity_id IS NOT NULL
         GROUP BY holder_entity_id, item_id HAVING sum(holder_delta) <> 0
      ) x GROUP BY holder_entity_id
    )
    SELECT e.id, e.name, e.kind,
           coalesce(eq.equipment_out, 0) AS equipment_out,
           coalesce(eq.overdue, 0) AS overdue,
           coalesce(sup.supplies_out, 0) AS supplies_out
      FROM entities e
      LEFT JOIN eq ON eq.entity_id = e.id
      LEFT JOIN sup ON sup.entity_id = e.id
     WHERE e.kind IN (${kinds}) OR eq.entity_id IS NOT NULL OR sup.entity_id IS NOT NULL
     ORDER BY e.name`);
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    equipmentOut: Number(r.equipment_out),
    overdue: Number(r.overdue),
    suppliesOut: Number(r.supplies_out),
  }));
}

/** Everything one holder is accountable for, and what moved since `since`. */
export async function holderDetail(holderId: string, since: Date) {
  const [holder] = await db
    .select({ id: entities.id, name: entities.name, kind: entities.kind })
    .from(entities)
    .where(eq(entities.id, holderId))
    .limit(1);
  if (!holder) throw notFound("That crew, truck or branch no longer exists.");
  const [supplies, movements, equipment] = await Promise.all([
    holderBalances({ holderId }),
    listMovements({ holderId, from: since, limit: 200 }),
    holderEquipment(holderId, since),
  ]);
  return { holder, since: since.toISOString(), supplies, movements, equipment };
}
