import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "../../db/client";
import { itemIdentifiers, itemUnits, items, type IdentifierType } from "../../db/schema";
import { badRequest, conflict, isUniqueViolation, notFound } from "../../lib/errors";
import { getItemDetail, recordEvent } from "../items";
import { visionJson } from "../ai/vision";

/**
 * Serial number and data-plate capture: one photo of an equipment label in, a
 * structured reading out, for a person to check before anything is saved.
 *
 * Nothing here writes on its own. readDataPlate only reads; applyDataPlate
 * takes the fields the person accepted (and may have corrected) and saves
 * them under the same uniqueness rules as typing them in.
 */

export const LOW_CONFIDENCE = 0.6;

export const DATA_PLATE_FIELDS = [
  "brand",
  "model",
  "serial",
  "partNumber",
  "assetTag",
  "mac",
  "manufactureDate",
  "voltage",
  "amperage",
  "wattage",
  "frequency",
] as const;
export type DataPlateField = (typeof DATA_PLATE_FIELDS)[number];

export type DataPlateReading = {
  brand: string | null;
  model: string | null;
  serial: string | null;
  partNumber: string | null;
  assetTag: string | null;
  mac: string | null;
  /** YYYY-MM or YYYY-MM-DD when the printed date could be read as one, else as printed. */
  manufactureDate: string | null;
  ratings: { voltage: string | null; amperage: string | null; wattage: string | null; frequency: string | null };
  otherIdentifiers: { label: string; value: string }[];
  /** 0 to 1 per field; 0 for a field that was not read. Below LOW_CONFIDENCE deserves a second look. */
  confidence: Record<DataPlateField, number>;
  rawText: string;
};

export const DATA_PLATE_SYSTEM =
  "You read equipment labels, data plates, rating stickers and asset tags from photos. " +
  "You copy exactly what is printed and never guess a value that is not visible. " +
  "Reply with one JSON object and nothing else.";

export const DATA_PLATE_PROMPT = `Read every label in the photo and reply with this JSON object:
{
  "brand": manufacturer or brand name, or null,
  "model": model number or name as printed (after "Model", "MOD", "Model No."), or null,
  "serial": serial number (after "S/N", "SN", "Serial No.", "SER") without that label, or null,
  "partNumber": part, product or catalogue number (after "P/N", "PN", "Part No.", "REF", "Cat. No."), or null,
  "assetTag": an organisation's own asset or inventory number, if a separate asset sticker is visible, or null,
  "mac": network MAC address, or null,
  "manufactureDate": date of manufacture ("MFG", "DOM", "Date") as printed, or null,
  "ratings": { "voltage": e.g. "100-240V~", "amperage": e.g. "2.5A", "wattage": e.g. "65W", "frequency": e.g. "50/60Hz" }, null for any not printed,
  "otherIdentifiers": [{ "label": the printed label, "value": the value }] for any other codes such as IMEI, FCC ID, UPC or service tag,
  "confidence": { "<field name>": a number from 0 to 1 } for every field you filled in, lower when the characters are small, blurred, reflective or ambiguous (0/O, 1/I/l, 5/S, 8/B),
  "rawText": all the text on the label, line by line
}
Copy characters exactly: do not correct, complete or reformat a value. If there is no readable label, set every field to null.`;

const PLACEHOLDER = new Set(["", "n/a", "na", "none", "null", "unknown", "-", "--", "?", "not visible", "not available"]);

/** A trimmed single-line string, or null for blanks and placeholders. */
export function cleanValue(v: unknown, max = 120): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (PLACEHOLDER.has(s.toLowerCase())) return null;
  return s.slice(0, max);
}

// Printed labels a model sometimes leaves on the value. Only stripped when
// followed by a separator, so a serial that really starts "SN" survives; the
// slash in "S/N" and "P/N" is distinctive enough to strip on its own.
const SERIAL_LABEL = /^(?:s\s*\/\s*n\s*[:#.]?|(?:serial(?:\s*(?:no|number|#))?|s\.?n\.?|ser)\s*(?:[:#.]|\s)\s*)\s*/i;
const MODEL_LABEL = /^(?:model(?:\s*(?:no|number|#))?|mod|mdl)\s*(?:[:#.]|\s)\s*/i;
const PART_LABEL = /^(?:p\s*\/\s*n\s*[:#.]?|(?:part(?:\s*(?:no|number|#))?|pn|ref|cat\.?\s*no)\s*(?:[:#.]|\s)\s*)\s*/i;

const stripLabel = (v: string | null, re: RegExp) => {
  if (!v) return null;
  const out = v.replace(re, "").trim();
  return out || null;
};

/** "aa-bb-cc-dd-ee-ff", "AABB.CCDD.EEFF" or "aabbccddeeff" → "AA:BB:CC:DD:EE:FF"; null if not 12 hex digits. */
export function normalizeMac(v: string | null): string | null {
  if (!v) return null;
  const hex = v.replace(/^mac\s*(?:address)?\s*[:#]?\s*/i, "").replace(/[\s:.-]/g, "");
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
  return hex.toUpperCase().match(/.{2}/g)!.join(":");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** A printed manufacture date as YYYY-MM or YYYY-MM-DD where it unambiguously is one; otherwise as printed. */
export function normalizeDate(v: string | null): string | null {
  if (!v) return null;
  const s = v.replace(/^(?:mfg|mfd|dom|date|manufactured)\s*(?:date)?\s*[:.]?\s*/i, "").trim();
  const okMonth = (m: number) => m >= 1 && m <= 12;
  let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/.exec(s);
  if (m && okMonth(Number(m[2]))) {
    const day = m[3] ? Number(m[3]) : null;
    if (day === null) return `${m[1]}-${pad(Number(m[2]))}`;
    if (day >= 1 && day <= 31) return `${m[1]}-${pad(Number(m[2]))}-${pad(day)}`;
  }
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m && okMonth(Number(m[1]))) return `${m[2]}-${pad(Number(m[1]))}`;
  m = /^([a-z]{3,9})\.?[\s,-]*(\d{4})$/i.exec(s);
  if (m) {
    const idx = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    if (idx >= 0) return `${m[2]}-${pad(idx + 1)}`;
  }
  return s || null;
}

/** A model's confidence in whatever form it chose: 0.9, 90, "0.9", "high". */
export function confidenceValue(v: unknown): number | null {
  if (typeof v === "string") {
    const word = v.trim().toLowerCase();
    if (word === "high") return 0.9;
    if (word === "medium") return 0.6;
    if (word === "low") return 0.3;
    v = Number(word.replace(/%$/, ""));
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  if (v > 1 && v <= 100) return v / 100;
  return v <= 1 ? v : null;
}

const squash = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");

/**
 * Turn whatever the model sent into a clean reading, or null when it sent
 * nothing usable. Pure, so every odd reply seen in the wild can be a test.
 *
 * One safeguard on top of the model's own confidence: an identifier that does
 * not appear anywhere in the transcribed label text is capped at 0.5, because
 * that is what an invented value looks like.
 */
export function normalizeDataPlate(raw: Record<string, unknown> | null): DataPlateReading | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const ratingsRaw = (raw.ratings && typeof raw.ratings === "object" ? raw.ratings : {}) as Record<string, unknown>;
  const rawText = typeof raw.rawText === "string" ? raw.rawText.trim().slice(0, 4000) : "";

  const otherIdentifiers: { label: string; value: string }[] = [];
  const pushOther = (label: string | null, value: string | null) => {
    if (value && otherIdentifiers.length < 20) otherIdentifiers.push({ label: label ?? "Other", value });
  };
  if (Array.isArray(raw.otherIdentifiers)) {
    for (const o of raw.otherIdentifiers) {
      if (typeof o === "string") {
        const [label, ...rest] = o.split(":");
        if (rest.length) pushOther(cleanValue(label, 60), cleanValue(rest.join(":")));
        else pushOther(null, cleanValue(o));
      } else if (o && typeof o === "object") {
        const rec = o as Record<string, unknown>;
        pushOther(cleanValue(rec.label ?? rec.name ?? rec.type, 60), cleanValue(rec.value ?? rec.code));
      }
    }
  }

  const macPrinted = cleanValue(raw.mac);
  const mac = normalizeMac(macPrinted);
  if (macPrinted && !mac) pushOther("MAC (unrecognised)", macPrinted);

  const reading: DataPlateReading = {
    brand: cleanValue(raw.brand),
    model: stripLabel(cleanValue(raw.model), MODEL_LABEL),
    serial: stripLabel(cleanValue(raw.serial), SERIAL_LABEL),
    partNumber: stripLabel(cleanValue(raw.partNumber ?? raw.part_number), PART_LABEL),
    assetTag: cleanValue(raw.assetTag ?? raw.asset_tag),
    mac,
    manufactureDate: normalizeDate(cleanValue(raw.manufactureDate ?? raw.manufacture_date)),
    ratings: {
      voltage: cleanValue(ratingsRaw.voltage ?? raw.voltage, 40),
      amperage: cleanValue(ratingsRaw.amperage ?? ratingsRaw.current ?? raw.amperage, 40),
      wattage: cleanValue(ratingsRaw.wattage ?? ratingsRaw.power ?? raw.wattage, 40),
      frequency: cleanValue(ratingsRaw.frequency ?? raw.frequency, 40),
    },
    otherIdentifiers,
    confidence: {} as Record<DataPlateField, number>,
    rawText,
  };

  const conf = (raw.confidence && typeof raw.confidence === "object" ? raw.confidence : {}) as Record<string, unknown>;
  const confRatings = (conf.ratings && typeof conf.ratings === "object" ? conf.ratings : {}) as Record<string, unknown>;
  const valueOf = (f: DataPlateField): string | null =>
    f === "voltage" || f === "amperage" || f === "wattage" || f === "frequency" ? reading.ratings[f] : reading[f];
  const haystack = squash(rawText);

  for (const field of DATA_PLATE_FIELDS) {
    const value = valueOf(field);
    if (!value) {
      reading.confidence[field] = 0;
      continue;
    }
    // Unstated confidence lands just under the line, so it gets looked at.
    let c = confidenceValue(conf[field] ?? conf[`ratings.${field}`] ?? confRatings[field]) ?? 0.5;
    const identifying = field === "serial" || field === "model" || field === "partNumber" || field === "assetTag" || field === "mac";
    if (identifying && haystack && !haystack.includes(squash(value))) c = Math.min(c, 0.5);
    reading.confidence[field] = Math.round(c * 100) / 100;
  }
  return reading;
}

/** True when the reading holds anything worth showing. */
export function readingFound(r: DataPlateReading | null): boolean {
  if (!r) return false;
  return Boolean(
    r.brand || r.model || r.serial || r.partNumber || r.assetTag || r.mac || r.manufactureDate ||
      Object.values(r.ratings).some(Boolean) || r.otherIdentifiers.length,
  );
}

/** Ask the vision model to read a label photo. Null when unavailable or unreadable. */
export async function readDataPlate(
  image: { mime: string; bytes: Buffer },
  context: Record<string, unknown> = {},
): Promise<DataPlateReading | null> {
  const raw = await visionJson({
    event: "ai.data_plate",
    system: DATA_PLATE_SYSTEM,
    prompt: DATA_PLATE_PROMPT,
    images: [image],
    maxTokens: 1200,
    context,
  });
  return normalizeDataPlate(raw);
}

export type TakenBy = { itemId: string; itemName: string; unitId: string | null };
export type TakenCheck = { serial: TakenBy | null; mac: TakenBy | null; assetTag: TakenBy | null };

// Identifier types that must be unique across all items (migration 0017).
const IDENTITY: IdentifierType[] = ["serial", "asset_tag", "mac", "rfid"];

/**
 * Whether any read identifier already belongs to something else, so the review
 * screen can say so before the person presses save. `exclude` is the record
 * being filled in, which may already carry the same value.
 */
export async function findTaken(
  values: { serial?: string | null; mac?: string | null; assetTag?: string | null },
  exclude: { itemId?: string | null; unitId?: string | null } = {},
): Promise<TakenCheck> {
  const result: TakenCheck = { serial: null, mac: null, assetTag: null };
  const wanted = (Object.entries(values) as [keyof TakenCheck, string | null | undefined][]).filter(
    (e): e is [keyof TakenCheck, string] => Boolean(e[1]?.trim()),
  );
  if (!wanted.length) return result;
  const list = wanted.map(([, v]) => v.trim());
  const typeFor: Record<keyof TakenCheck, IdentifierType> = { serial: "serial", mac: "mac", assetTag: "asset_tag" };

  const [idRows, unitRows] = await Promise.all([
    db
      .select({ value: itemIdentifiers.value, type: itemIdentifiers.type, itemId: items.id, itemName: items.name })
      .from(itemIdentifiers)
      .innerJoin(items, eq(items.id, itemIdentifiers.itemId))
      .where(and(inArray(itemIdentifiers.value, list), inArray(itemIdentifiers.type, IDENTITY))),
    db
      .select({ serial: itemUnits.serial, unitId: itemUnits.id, itemId: items.id, itemName: items.name })
      .from(itemUnits)
      .innerJoin(items, eq(items.id, itemUnits.itemId))
      .where(inArray(itemUnits.serial, list)),
  ]);

  for (const [field, raw] of wanted) {
    const value = raw.trim();
    const byId = idRows.find(
      (r) => r.value === value && !(r.itemId === exclude.itemId && r.type === typeFor[field]),
    );
    if (byId) {
      result[field] = { itemId: byId.itemId, itemName: byId.itemName, unitId: null };
      continue;
    }
    if (field === "serial") {
      const byUnit = unitRows.find((r) => r.serial === value && r.unitId !== exclude.unitId);
      if (byUnit) result.serial = { itemId: byUnit.itemId, itemName: byUnit.itemName, unitId: byUnit.unitId };
    }
  }
  return result;
}

/** findTaken for a reading about to be saved on an item or unit (or on nothing yet). */
export async function takenForOwner(
  reading: DataPlateReading,
  owner: { ownerType?: "item" | "unit"; ownerId?: string },
): Promise<TakenCheck> {
  let exclude: { itemId?: string | null; unitId?: string | null } = {};
  if (owner.ownerType === "item" && owner.ownerId) exclude = { itemId: owner.ownerId };
  if (owner.ownerType === "unit" && owner.ownerId) {
    const [unit] = await db
      .select({ itemId: itemUnits.itemId })
      .from(itemUnits)
      .where(eq(itemUnits.id, owner.ownerId))
      .limit(1);
    exclude = { itemId: unit?.itemId ?? null, unitId: owner.ownerId };
  }
  return findTaken({ serial: reading.serial, mac: reading.mac, assetTag: reading.assetTag }, exclude);
}

export type ApplyDataPlateInput = {
  ownerType: "item" | "unit";
  ownerId: string;
  brand?: string | null;
  model?: string | null;
  serial?: string | null;
  mac?: string | null;
  assetTag?: string | null;
  partNumber?: string | null;
};

const LABELS: Record<keyof TakenCheck, string> = { serial: "Serial", mac: "MAC address", assetTag: "Asset tag" };

/**
 * Save the fields a person accepted. Brand and model fill the item; serial,
 * MAC and asset tag become identifiers under the existing uniqueness rules;
 * the part number becomes a SKU identifier, which is a product code and may
 * repeat. For a unit, the serial goes on the unit itself. All or nothing.
 */
export async function applyDataPlate(input: ApplyDataPlateInput, userOid: string | null) {
  const clean = (v: string | null | undefined) => cleanValue(v ?? null, 200);
  const brand = clean(input.brand);
  const model = clean(input.model);
  const serial = clean(input.serial);
  const assetTag = clean(input.assetTag);
  const partNumber = clean(input.partNumber);
  const macIn = clean(input.mac);
  const mac = macIn ? normalizeMac(macIn) : null;
  if (macIn && !mac) throw badRequest(`"${macIn}" is not a MAC address. It should be 12 hex digits, such as AA:BB:CC:DD:EE:FF.`);

  let itemId = input.ownerId;
  let unitId: string | null = null;
  if (input.ownerType === "unit") {
    const [unit] = await db.select({ itemId: itemUnits.itemId }).from(itemUnits).where(eq(itemUnits.id, input.ownerId)).limit(1);
    if (!unit) throw notFound("That unit no longer exists.");
    itemId = unit.itemId;
    unitId = input.ownerId;
  } else {
    const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, input.ownerId)).limit(1);
    if (!item) throw notFound("That item no longer exists.");
  }

  const taken = await findTaken({ serial, mac, assetTag }, { itemId, unitId });
  for (const field of ["serial", "mac", "assetTag"] as const) {
    const t = taken[field];
    if (!t) continue;
    const value = field === "serial" ? serial : field === "mac" ? mac : assetTag;
    const where =
      t.itemId !== itemId
        ? `"${t.itemName}"`
        : t.unitId
          ? "another unit of this item"
          : "this item, as a different kind of identifier";
    throw conflict(`${LABELS[field]} "${value}" is already on ${where}. Correct the reading, or remove it there first.`);
  }

  const toAdd: { type: IdentifierType; value: string }[] = [];
  if (serial && !unitId) toAdd.push({ type: "serial", value: serial });
  if (mac) toAdd.push({ type: "mac", value: mac });
  if (assetTag) toAdd.push({ type: "asset_tag", value: assetTag });
  if (partNumber) toAdd.push({ type: "sku", value: partNumber });

  const fields: string[] = [];
  try {
    await db.transaction(async (tx) => {
      if (brand || model) {
        await tx
          .update(items)
          .set({ ...(brand ? { brand } : {}), ...(model ? { model } : {}), updatedAt: new Date() })
          .where(eq(items.id, itemId));
        if (brand) fields.push("brand");
        if (model) fields.push("model");
      }
      if (unitId && serial) {
        await tx.update(itemUnits).set({ serial, updatedAt: new Date() }).where(eq(itemUnits.id, unitId));
        fields.push("unit.serial");
      }
      if (toAdd.length) {
        // Skip what the item already carries, so reading the same label twice is harmless.
        const existing = await tx
          .select({ type: itemIdentifiers.type, value: itemIdentifiers.value })
          .from(itemIdentifiers)
          .where(
            and(
              eq(itemIdentifiers.itemId, itemId),
              or(...toAdd.map((a) => and(eq(itemIdentifiers.type, a.type), eq(itemIdentifiers.value, a.value)))),
            ),
          );
        const fresh = toAdd.filter((a) => !existing.some((e) => e.type === a.type && e.value === a.value));
        if (fresh.length) {
          await tx.insert(itemIdentifiers).values(fresh.map((a) => ({ itemId, type: a.type, value: a.value })));
          fields.push(...fresh.map((a) => a.type));
        }
      }
    });
  } catch (err) {
    if (isUniqueViolation(err, "uq_item_units_serial")) {
      throw conflict(`Serial "${serial}" is already on another unit. Correct the reading, or remove it there first.`);
    }
    if (isUniqueViolation(err, "uq_item_identifiers_identity_value", "uq_item_identifiers_value")) {
      throw conflict("One of those identifiers was just added to another item. Read the label again.");
    }
    throw err;
  }

  if (fields.length) {
    await recordEvent(itemId, userOid, "updated", { source: "data-plate", fields, ...(unitId ? { unitId } : {}) });
  }
  return getItemDetail(itemId);
}
