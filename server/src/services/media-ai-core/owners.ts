import { pool } from "../../db/client";
import { badRequest, notFound } from "../../lib/errors";

/**
 * Which kinds of record may own attachments and signatures.
 *
 * This module cannot know every table a later feature adds, so each feature
 * registers its own owner type once, at module load:
 *
 *   registerOwnerType("job", async (id) => (await getJob(id)) !== null, { table: "jobs" });
 *
 * `exists` is what an upload checks before accepting a file. `table` (and
 * `idColumn`, default "id") lets the background sweep find attachments whose
 * owner has been deleted with one anti-join rather than one call per row;
 * without it, orphans of that type are never swept, so give it whenever the
 * owner is a plain row.
 */

export type OwnerExists = (id: string) => Promise<boolean>;
export type OwnerOptions = {
  /** Table holding the owner rows, for the orphan sweep. */
  table?: string;
  /** Primary key column of `table`. Defaults to "id". */
  idColumn?: string;
  /** Human word used in error messages ("job", "claim"). Defaults to the name. */
  label?: string;
};

type OwnerType = { name: string; exists: OwnerExists } & OwnerOptions;

const registry = new Map<string, OwnerType>();

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerOwnerType(name: string, exists: OwnerExists, options: OwnerOptions = {}): void {
  if (!NAME.test(name)) throw new Error(`Owner type "${name}" must be lowercase letters, digits and underscores.`);
  // Interpolated into the sweep's SQL, so held to a strict identifier shape.
  if (options.table && !IDENT.test(options.table)) throw new Error(`Owner table "${options.table}" is not a plain identifier.`);
  if (options.idColumn && !IDENT.test(options.idColumn)) {
    throw new Error(`Owner id column "${options.idColumn}" is not a plain identifier.`);
  }
  registry.set(name, { name, exists, ...options });
}

export function ownerTypes(): OwnerType[] {
  return [...registry.values()];
}

export function isOwnerType(name: string): boolean {
  return registry.has(name);
}

/**
 * Throws a 400 for an unknown owner type or a malformed id, and a 404 when the
 * owner does not exist, so uploads to a deleted record fail clearly.
 */
export async function assertOwner(ownerType: string, ownerId: string): Promise<void> {
  const type = registry.get(ownerType);
  if (!type) {
    throw badRequest(
      `Attachments cannot belong to "${ownerType}". Use one of: ${[...registry.keys()].join(", ")}.`,
    );
  }
  if (!UUID.test(ownerId)) throw badRequest("ownerId must be the id (a UUID) of the record the file belongs to.");
  if (!(await type.exists(ownerId))) {
    throw notFound(`That ${type.label ?? type.name} does not exist. It may have been deleted.`);
  }
}

const rowExists = (table: string) => async (id: string) => {
  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
};

// The records that exist in every instance. Features that add their own
// register them next to their own code.
registerOwnerType("item", rowExists("items"), { table: "items" });
registerOwnerType("unit", rowExists("item_units"), { table: "item_units" });
registerOwnerType("location", rowExists("locations"), { table: "locations" });
