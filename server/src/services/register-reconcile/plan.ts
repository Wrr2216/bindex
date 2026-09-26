import { createHash } from "node:crypto";
import type { IdentifierType } from "../../db/schema";
import { normalizeEpc, normKey } from "./normalize";
import { displayName } from "./presets";

/**
 * What "Import as new items" would create, decided without touching the
 * database. The preview and the commit both call this, and the commit refuses
 * to run when its plan hashes differently from the one the person saw, so
 * what is created is exactly what was previewed.
 */

export type PlanRow = {
  id: string;
  rowNumber: number;
  assetTag: string | null;
  serial: string | null;
  epc: string | null;
  name: string | null;
  model: string | null;
  brand: string | null;
  category: string | null;
  description: string | null;
  locationText: string | null;
  registerLocationId: string | null;
  custodian: string | null;
  costCents: number | null;
  purchaseDate: string | null;
  quantity: number | null;
  createdItemId: string | null;
};

/** Identity keys already in use here, each pointing at the printed code that holds it. */
export type ExistingKeys = {
  assetTags: Map<string, string>;
  serials: Map<string, string>;
  epcs: Map<string, string>;
};

export type PlanOptions = {
  importId: string;
  importName: string;
  companyId: string | null;
  /** Used for rows whose location did not resolve. */
  defaultLocationId: string | null;
};

export type PlannedItem = {
  rowId: string;
  rowNumber: number;
  name: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  description: string | null;
  quantity: number;
  valueCents: number | null;
  locationId: string | null;
  companyId: string | null;
  identifiers: { type: IdentifierType; value: string }[];
  metadata: Record<string, unknown>;
};

export type PlanSkip = { rowId: string; rowNumber: number; reason: string };
export type PlanWarning = { rowId: string; rowNumber: number; message: string };

export type ImportPlan = {
  create: PlannedItem[];
  skip: PlanSkip[];
  warnings: PlanWarning[];
  hash: string;
};

export function planImport(rows: PlanRow[], existing: ExistingKeys, opts: PlanOptions): ImportPlan {
  const create: PlannedItem[] = [];
  const skip: PlanSkip[] = [];
  const warnings: PlanWarning[] = [];
  const inFile = new Map<string, number>(); // "serial:ABC" -> first row number

  for (const row of [...rows].sort((a, b) => a.rowNumber - b.rowNumber)) {
    const skipRow = (reason: string) => skip.push({ rowId: row.id, rowNumber: row.rowNumber, reason });
    if (row.createdItemId) {
      skipRow("Already imported from this register.");
      continue;
    }
    const name = displayName(row);
    if (!name) {
      skipRow("No name, model, description, tag or serial to call it by.");
      continue;
    }

    const keys: { label: string; type: IdentifierType; value: string; norm: string; taken: Map<string, string> }[] = [];
    const tag = normKey(row.assetTag);
    if (tag) keys.push({ label: "Asset tag", type: "asset_tag", value: row.assetTag!.trim(), norm: tag, taken: existing.assetTags });
    const serial = normKey(row.serial);
    if (serial) keys.push({ label: "Serial", type: "serial", value: row.serial!.trim(), norm: serial, taken: existing.serials });
    const epc = normalizeEpc(row.epc);
    if (epc) keys.push({ label: "EPC", type: "rfid", value: epc, norm: epc, taken: existing.epcs });

    const clash = keys.find((k) => k.taken.has(k.norm));
    if (clash) {
      skipRow(`${clash.label} ${clash.value} is already on ${clash.taken.get(clash.norm)}.`);
      continue;
    }
    const repeat = keys.find((k) => inFile.has(`${k.type}:${k.norm}`));
    if (repeat) {
      skipRow(`${repeat.label} ${repeat.value} is the same as row ${inFile.get(`${repeat.type}:${repeat.norm}`)}.`);
      continue;
    }
    for (const k of keys) inFile.set(`${k.type}:${k.norm}`, row.rowNumber);

    let locationId = row.registerLocationId;
    if (!locationId && row.locationText) {
      warnings.push({
        rowId: row.id,
        rowNumber: row.rowNumber,
        message: `Location "${row.locationText}" is not mapped${opts.defaultLocationId ? "; using the default" : "; left without a location"}.`,
      });
    }
    locationId ??= opts.defaultLocationId;

    const register: Record<string, unknown> = {
      importId: opts.importId,
      importName: opts.importName,
      row: row.rowNumber,
    };
    if (row.purchaseDate) register.purchaseDate = row.purchaseDate;
    if (row.custodian) register.custodian = row.custodian;
    if (row.locationText) register.location = row.locationText;

    create.push({
      rowId: row.id,
      rowNumber: row.rowNumber,
      name: name.slice(0, 300),
      brand: row.brand,
      model: row.model,
      category: row.category,
      description: row.description && row.description !== name ? row.description : null,
      quantity: row.quantity && row.quantity > 0 ? row.quantity : 1,
      valueCents: row.costCents,
      locationId,
      companyId: opts.companyId,
      identifiers: keys.map((k) => ({ type: k.type, value: k.value })),
      metadata: { register },
    });
  }

  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        create.map((c) => [
          c.rowId,
          c.name,
          c.brand,
          c.model,
          c.category,
          c.description,
          c.quantity,
          c.valueCents,
          c.locationId,
          c.companyId,
          c.identifiers,
        ]),
      ),
    )
    .digest("hex");

  return { create, skip, warnings, hash };
}
