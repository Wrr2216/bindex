import { pool } from "../../db/client";
import { registerOwnerType } from "../media-ai-core";

/**
 * Photos and documents can be attached to a claim (a repair quote, a receipt,
 * photos taken when it was reported) and to one of its lines (close-ups of
 * that item's damage). The evidence pack picks both up.
 */

const exists = (table: "claims" | "claim_lines") => async (id: string) => {
  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
};

registerOwnerType("claim", exists("claims"), { table: "claims", label: "claim" });
registerOwnerType("claim_line", exists("claim_lines"), { table: "claim_lines", label: "claim line" });
