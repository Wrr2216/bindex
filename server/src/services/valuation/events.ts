import { pool } from "../../db/client";
import { registerEventTypes } from "../event-backbone";
import { registerOwnerType } from "../media-ai-core";

/**
 * What this feature adds to the shared registries: the event types it
 * publishes (for the webhook picker) and the records that may own attachments
 * and signatures. Imported once by the feature's index so both are in place
 * before any request.
 */

const GROUP = "Valuation";

registerEventTypes([
  {
    type: "valuation.recorded",
    group: GROUP,
    subject: "item",
    description: "A value was recorded for an item or unit: by AI estimate, receipt, web price, appraisal or by hand.",
  },
  {
    type: "valuation.high_value_marked",
    group: GROUP,
    subject: "item",
    description: "A new value put an item or unit at or over the high-value threshold.",
  },
  {
    type: "declaration.created",
    group: GROUP,
    subject: "hv_declaration",
    description: "A high-value declaration was started.",
  },
  {
    type: "declaration.signed",
    group: GROUP,
    subject: "hv_declaration",
    description: "A high-value declaration was signed; its lines and total are now fixed.",
  },
  {
    type: "declaration.deleted",
    group: GROUP,
    subject: "hv_declaration",
    description: "A draft high-value declaration was deleted.",
  },
  {
    type: "receipt.confirmed",
    group: GROUP,
    subject: "receipt",
    description: "A receipt's lines were confirmed against items, saving purchase date, price and vendor on each.",
  },
  {
    type: "warranty.expiring",
    group: GROUP,
    subject: "item",
    description: "An item's or unit's warranty ends within the reminder window. Sent once per end date.",
  },
  {
    type: "service.due",
    group: GROUP,
    subject: "item",
    description: "Scheduled service is due soon or overdue, by date or by hours of use. Sent once per due point.",
  },
  {
    type: "service.logged",
    group: GROUP,
    subject: "item",
    description: "Service was recorded as done, moving the plan's next due point.",
  },
]);

const rowExists = (table: "receipts" | "hv_declarations") => async (id: string) => {
  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
};

registerOwnerType("receipt", rowExists("receipts"), { table: "receipts" });
registerOwnerType("hv_declaration", rowExists("hv_declarations"), { table: "hv_declarations", label: "declaration" });
