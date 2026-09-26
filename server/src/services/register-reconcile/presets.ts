import type { ColumnMapping, RegisterField, RegisterPreset } from "../../db/tables/register-reconcile";
import {
  headerKey,
  normalizeEpc,
  parseCost,
  parseDate,
  parseQuantity,
} from "./normalize";

/**
 * Which register column feeds which normalised field, per source system.
 *
 * Aliases are compared by letters and digits only (see headerKey), so each is
 * listed once however the exporter punctuates it. A preset's own aliases are
 * tried before the generic ones, so "Name" in a Snipe-IT export means the
 * asset name while "Description" in an ERP register means the name.
 */

export const FIELDS: { key: RegisterField; label: string; hint: string }[] = [
  { key: "assetTag", label: "Asset tag", hint: "The register's own asset number or tag." },
  { key: "serial", label: "Serial number", hint: "Manufacturer serial." },
  { key: "epc", label: "RFID / EPC", hint: "Tag EPC in hex; separators are ignored." },
  { key: "bindexCode", label: "Printed code", hint: "A code printed by this instance, when the register records it." },
  { key: "name", label: "Name", hint: "What the asset is called." },
  { key: "model", label: "Model", hint: "Model name or number." },
  { key: "brand", label: "Manufacturer", hint: "Brand or manufacturer." },
  { key: "category", label: "Category", hint: "Asset class or category." },
  { key: "description", label: "Description", hint: "Longer text, kept as the description." },
  { key: "locationText", label: "Location", hint: "Where the register says it is." },
  { key: "custodian", label: "Custodian", hint: "Who the register says has it." },
  { key: "cost", label: "Cost", hint: "Purchase or book cost." },
  { key: "purchaseDate", label: "Purchase date", hint: "Purchase, acquisition or in-service date." },
  { key: "quantity", label: "Quantity", hint: "How many, when one row is several identical things." },
];

export type PresetInfo = {
  key: RegisterPreset;
  label: string;
  description: string;
  aliases: Partial<Record<RegisterField, string[]>>;
};

const GENERIC: PresetInfo["aliases"] = {
  assetTag: ["asset tag", "tag", "asset tag number", "tag number", "asset", "asset id", "asset no", "asset number", "inventory number", "inventory no", "property tag"],
  serial: ["serial", "serial number", "serial no", "sn", "s/n", "serialnumber", "service tag"],
  epc: ["epc", "rfid", "rfid tag", "rfid epc", "tag epc", "epc hex", "uhf tag"],
  bindexCode: ["bindex code", "printed code", "bindex asset code", "inventory code"],
  name: ["name", "item", "item name", "asset name", "title", "device name", "hostname"],
  model: ["model", "model number", "model no", "model name", "part number", "mpn"],
  brand: ["manufacturer", "brand", "make", "vendor"],
  category: ["category", "type", "asset type", "asset class", "class", "kind"],
  description: ["description", "notes", "details"],
  locationText: ["location", "room", "site", "building", "place", "area", "location name"],
  custodian: ["custodian", "assigned to", "owner", "user", "checked out to", "holder", "employee", "responsible"],
  cost: ["cost", "price", "value", "purchase price", "purchase cost", "amount", "unit cost"],
  purchaseDate: ["purchase date", "purchased", "date purchased", "acquired", "acquisition date", "bought"],
  quantity: ["quantity", "qty", "count", "units"],
};

export const PRESETS: PresetInfo[] = [
  {
    key: "generic",
    label: "Generic",
    description: "Any spreadsheet. Columns are matched by common header names.",
    aliases: {},
  },
  {
    key: "snipeit",
    label: "Snipe-IT asset export",
    description: "The asset list exported from Snipe-IT (Hardware, Export) or its custom asset report.",
    aliases: {
      assetTag: ["asset tag"],
      serial: ["serial", "serial number"],
      name: ["asset name", "name", "item name"],
      model: ["model no", "model number", "model"],
      brand: ["manufacturer"],
      category: ["category"],
      description: ["notes"],
      locationText: ["location", "default location", "rtd location"],
      custodian: ["checked out to", "assigned to", "full name", "username", "email"],
      cost: ["purchase cost"],
      purchaseDate: ["purchase date"],
    },
  },
  {
    key: "homebox",
    label: "Homebox export",
    description: "The CSV written by Homebox (Tools, Export inventory), with HB.-prefixed columns.",
    aliases: {
      assetTag: ["hb.asset_id"],
      serial: ["hb.serial_number"],
      name: ["hb.name"],
      model: ["hb.model_number"],
      brand: ["hb.manufacturer"],
      category: ["hb.labels"],
      description: ["hb.description", "hb.notes"],
      locationText: ["hb.location"],
      cost: ["hb.purchase_price"],
      purchaseDate: ["hb.purchase_time", "hb.purchase_date"],
      quantity: ["hb.quantity"],
    },
  },
  {
    key: "erp",
    label: "ERP fixed-asset register",
    description:
      "A fixed-asset register from an accounting or ERP system: asset number, description, serial, location, cost and acquisition date.",
    aliases: {
      assetTag: ["asset number", "asset no", "asset id", "fixed asset number", "fa number", "asset"],
      serial: ["serial number", "serial no", "serial"],
      name: ["description", "asset description", "asset name", "name"],
      model: ["model"],
      category: ["asset class", "asset category", "class", "category", "asset group"],
      locationText: ["location", "location code", "cost center location", "site"],
      custodian: ["custodian", "responsible person", "employee", "responsible"],
      cost: ["acquisition cost", "original cost", "historical cost", "cost", "acquisition value", "gross book value"],
      purchaseDate: ["acquisition date", "date acquired", "in service date", "in-service date", "capitalization date", "capitalisation date", "placed in service"],
    },
  },
];

export function presetInfo(key: RegisterPreset): PresetInfo {
  return PRESETS.find((p) => p.key === key) ?? PRESETS[0]!;
}

/** Guess which system wrote a file from its headers alone. */
export function detectPreset(headers: string[]): RegisterPreset {
  const keys = new Set(headers.map(headerKey));
  if (headers.some((h) => /^hb\./i.test(h.trim()))) return "homebox";
  const has = (...names: string[]) => names.some((n) => keys.has(headerKey(n)));
  if (has("asset tag") && has("checked out to", "model no", "model no.", "default location", "purchase cost")) {
    return "snipeit";
  }
  if (has("acquisition date", "acquisition cost", "date acquired", "in service date", "capitalization date", "original cost")) {
    return "erp";
  }
  return "generic";
}

/**
 * Map each field to a header. Preset aliases win over generic ones, and a
 * header is only used once, in the order FIELDS lists them, so "Asset tag"
 * cannot also become the name.
 */
export function autoMap(headers: string[], preset: RegisterPreset): ColumnMapping {
  const byKey = new Map<string, string>();
  for (const h of headers) if (!byKey.has(headerKey(h))) byKey.set(headerKey(h), h);
  const used = new Set<string>();
  const mapping: ColumnMapping = {};
  const own = presetInfo(preset).aliases;
  for (const pass of [own, GENERIC]) {
    for (const { key } of FIELDS) {
      if (mapping[key]) continue;
      for (const alias of pass[key] ?? []) {
        const header = byKey.get(headerKey(alias));
        if (header && !used.has(header)) {
          mapping[key] = header;
          used.add(header);
          break;
        }
      }
    }
  }
  return mapping;
}

export type NormalizedRow = {
  assetTag: string | null;
  serial: string | null;
  epc: string | null;
  bindexCode: string | null;
  name: string | null;
  model: string | null;
  brand: string | null;
  category: string | null;
  description: string | null;
  locationText: string | null;
  custodian: string | null;
  costCents: number | null;
  purchaseDate: string | null;
  quantity: number | null;
  issues: string[];
};

const text = (v: string | undefined, max = 500): string | null => {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

/** One register row, through a mapping, into the fields that get compared. */
export function normalizeRow(
  cells: Record<string, string>,
  mapping: ColumnMapping,
  opts: { dayFirst?: boolean } = {},
): NormalizedRow {
  const get = (field: RegisterField) => {
    const header = mapping[field];
    return header ? cells[header] : undefined;
  };
  const issues: string[] = [];
  const cost = parseCost(get("cost"));
  if (cost.issue) issues.push(`Cost: ${cost.issue}`);
  const date = parseDate(get("purchaseDate"), opts.dayFirst);
  if (date.issue) issues.push(`Purchase date: ${date.issue}`);
  const qty = parseQuantity(get("quantity"));
  if (qty.issue) issues.push(`Quantity: ${qty.issue}`);

  const description = get("description")?.trim() || null;
  return {
    assetTag: text(get("assetTag"), 200),
    serial: text(get("serial"), 200),
    epc: normalizeEpc(get("epc")),
    bindexCode: text(get("bindexCode"), 64)?.toUpperCase() ?? null,
    name: text(get("name")),
    model: text(get("model"), 200),
    brand: text(get("brand"), 200),
    category: text(get("category"), 200),
    description: description ? description.slice(0, 4000) : null,
    locationText: text(get("locationText")),
    custodian: text(get("custodian"), 200),
    costCents: cost.value,
    purchaseDate: date.value,
    quantity: qty.value,
    issues,
  };
}

/**
 * The name an asset gets when the register has none: its model, then the
 * start of its description, then its tag.
 */
export function displayName(row: Pick<NormalizedRow, "name" | "model" | "description" | "assetTag" | "serial">): string | null {
  return (
    row.name ??
    row.model ??
    (row.description ? row.description.split(/\r?\n/)[0]!.slice(0, 120) : null) ??
    row.assetTag ??
    row.serial ??
    null
  );
}

/** Instances outside the US write day-first numeric dates. */
export function dayFirstForLocale(locale: string): boolean {
  return !/^en-(US|PH)$/i.test(locale) && !/^en$/i.test(locale);
}
