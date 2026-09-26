import { pool } from "../../db/client";
import { normalizeCode } from "./normalize";

/**
 * Batch resolution of raw codes from hardware to the asset they belong to.
 *
 * This is the hardware path, so it differs from the interactive scanner
 * (items.getByIdentifier) on purpose: exact matches only, no fuzzy model
 * lookup, and no "scanned" history event, because a portal reading a pallet
 * a thousand times an hour must not flood an item's history. It runs a fixed
 * five queries however many codes it is given.
 */

export type ResolveSource = "identifier" | "device" | "item_code" | "unit_code" | "unit_serial";

export type ResolvedAsset = {
  itemId: string;
  /** Set when the code identifies one unit rather than the item as a whole. */
  unitId: string | null;
  /** What matched, for display and debugging. */
  via: ResolveSource;
};

// When one code matches in several places, the more specific binding wins: a
// tag bound to an item beats a printed code that happens to look the same.
const PRIORITY: Record<ResolveSource, number> = {
  identifier: 5,
  device: 4,
  item_code: 3,
  unit_code: 2,
  unit_serial: 1,
};

// Identifier types that name one physical thing, as opposed to a product code
// several items can share.
const IDENTITY_TYPES = new Set(["rfid", "serial", "asset_tag", "mac"]);

type Candidate = {
  itemId: string;
  unitId: string | null;
  source: ResolveSource;
  exact: boolean;
  identity: boolean;
};

type Row = { value: string; item_id: string; unit_id?: string | null; type?: string };

/**
 * Resolve codes to assets. The result is keyed by each input code, trimmed;
 * codes that match nothing, or match two different assets equally well, are
 * absent.
 *
 * Matching is exact first, then on the normalized form (hex EPCs compared
 * uppercase without separators) on both sides, so a tag stored as
 * "e2 80 11..." still matches a reader that sends "E28011...".
 */
export async function resolveCodes(codes: Iterable<string>): Promise<Map<string, ResolvedAsset>> {
  const inputs = [...new Set([...codes].map((c) => c.trim()).filter(Boolean))];
  const out = new Map<string, ResolvedAsset>();
  if (!inputs.length) return out;

  const byNorm = new Map<string, string[]>();
  for (const code of inputs) {
    const n = normalizeCode(code);
    const list = byNorm.get(n);
    if (list) list.push(code);
    else byNorm.set(n, [code]);
  }
  const exactValues = [...new Set([...inputs, ...byNorm.keys()])];
  const normValues = [...byNorm.keys()];

  const [identifiers, devices, itemCodes, unitCodes, unitSerials] = await Promise.all([
    pool.query<Row>(
      `SELECT value, item_id, type FROM item_identifiers
        WHERE value = ANY($1::text[]) OR tracking_normalize_code(value) = ANY($2::text[])`,
      [exactValues, normValues],
    ),
    // A tag or tracker registered as a device and attached to an asset.
    pool.query<Row>(
      `SELECT external_id AS value, item_id, unit_id FROM tracking_devices
        WHERE item_id IS NOT NULL AND NOT disabled AND external_id IS NOT NULL
          AND (external_id = ANY($1::text[]) OR tracking_normalize_code(external_id) = ANY($2::text[]))`,
      [exactValues, normValues],
    ),
    pool.query<Row>(`SELECT asset_code AS value, id AS item_id FROM items WHERE asset_code = ANY($1::text[])`, [
      exactValues,
    ]),
    pool.query<Row>(
      `SELECT asset_code AS value, item_id, id AS unit_id FROM item_units WHERE asset_code = ANY($1::text[])`,
      [exactValues],
    ),
    pool.query<Row>(
      `SELECT serial AS value, item_id, id AS unit_id FROM item_units
        WHERE serial IS NOT NULL
          AND (serial = ANY($1::text[]) OR tracking_normalize_code(serial) = ANY($2::text[]))`,
      [exactValues, normValues],
    ),
  ]);

  const candidates = new Map<string, Candidate[]>();
  const add = (rows: Row[], source: ResolveSource) => {
    for (const row of rows) {
      for (const code of byNorm.get(normalizeCode(row.value)) ?? []) {
        const list = candidates.get(code) ?? [];
        list.push({
          itemId: row.item_id,
          unitId: row.unit_id ?? null,
          source,
          exact: code === row.value,
          identity: source !== "identifier" || IDENTITY_TYPES.has(row.type ?? ""),
        });
        candidates.set(code, list);
      }
    }
  };
  add(identifiers.rows, "identifier");
  add(devices.rows, "device");
  add(itemCodes.rows, "item_code");
  add(unitCodes.rows, "unit_code");
  add(unitSerials.rows, "unit_serial");

  for (const [code, list] of candidates) {
    const best = pickBest(list);
    if (best) out.set(code, { itemId: best.itemId, unitId: best.unitId, via: best.source });
  }
  return out;
}

/** Resolve one code. */
export async function resolveCode(code: string): Promise<ResolvedAsset | null> {
  return (await resolveCodes([code])).get(code.trim()) ?? null;
}

const rank = (c: Candidate) => PRIORITY[c.source] * 4 + (c.exact ? 2 : 0) + (c.identity ? 1 : 0);

/**
 * The best candidate, walking down from the strongest match. A tier that
 * names two different assets is ambiguous (a product code on several items)
 * and is skipped rather than guessed.
 */
function pickBest(list: Candidate[]): Candidate | null {
  const tiers = new Map<number, Candidate[]>();
  for (const c of list) {
    const r = rank(c);
    tiers.set(r, [...(tiers.get(r) ?? []), c]);
  }
  for (const r of [...tiers.keys()].sort((a, b) => b - a)) {
    const tier = tiers.get(r)!;
    const assets = new Set(tier.map((c) => `${c.itemId}/${c.unitId ?? ""}`));
    if (assets.size === 1) return tier[0]!;
  }
  return null;
}
