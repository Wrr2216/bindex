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
  /**
   * Every serial, asset tag, MAC, RFID, NFC and legacy value whatever its type,
   * by normKey: the unique index from 0028 holds each value once across all six.
   */
  identities: Map<string, string>;
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

/** One identity key a row carries; `norm` is compared within its type, against `taken`. */
type Key = { label: string; type: IdentifierType; value: string; norm: string; taken: Map<string, string> };

/** The stored value whatever its type, as the identity index compares it (normalized like tags and serials). */
const identity = (k: Key) => normKey(k.value)!;

export function planImport(rows: PlanRow[], existing: ExistingKeys, opts: PlanOptions): ImportPlan {
  const create: PlannedItem[] = [];
  const skip: PlanSkip[] = [];
  const warnings: PlanWarning[] = [];
  const inFile = new Map<string, number>(); // normKey(value) -> first row number

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

    const keys: Key[] = [];
    const tag = normKey(row.assetTag);
    if (tag) keys.push({ label: "Asset tag", type: "asset_tag", value: row.assetTag!.trim(), norm: tag, taken: existing.assetTags });
    const serial = normKey(row.serial);
    if (serial) keys.push({ label: "Serial", type: "serial", value: row.serial!.trim(), norm: serial, taken: existing.serials });
    const epc = normalizeEpc(row.epc);
    if (epc) keys.push({ label: "EPC", type: "rfid", value: epc, norm: epc, taken: existing.epcs });

    // The identity index is on the value alone, so values are compared across
    // types too: a tag that is also another item's MAC or serial clashes, and
    // a row whose tag is also its serial keeps that value once, as the tag.
    const heldBy = (k: Key) => k.taken.get(k.norm) ?? existing.identities.get(identity(k));
    const clash = keys.find(heldBy);
    if (clash) {
      skipRow(`${clash.label} ${clash.value} is already on ${heldBy(clash)}.`);
      continue;
    }
    const repeat = keys.find((k) => inFile.has(identity(k)));
    if (repeat) {
      skipRow(`${repeat.label} ${repeat.value} is the same as row ${inFile.get(identity(repeat))}.`);
      continue;
    }
    const kept = new Map<string, Key>();
    for (const k of keys) {
      const first = kept.get(identity(k));
      if (!first) {
        kept.set(identity(k), k);
        continue;
      }
      warnings.push({
        rowId: row.id,
        rowNumber: row.rowNumber,
        message: `${k.label} ${k.value} is the same as the ${first.label.toLowerCase()}; recorded once, as the ${first.label.toLowerCase()}.`,
      });
    }
    for (const id of kept.keys()) inFile.set(id, row.rowNumber);

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
      identifiers: [...kept.values()].map((k) => ({ type: k.type, value: k.value })),
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
