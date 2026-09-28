import type {
  MatchMethod,
  ReconcileClass,
  ResultConflict,
} from "../../db/tables/register-reconcile";
import { normalizeEpc, normKey, normText } from "./normalize";

/**
 * Matching a register against what this instance holds, and sorting every row
 * and every asset into the classes a person acts on. Pure: the database layer
 * loads rows and assets, this decides, and the tests drive it with fixtures.
 *
 * An "asset" (a target) is an item, or one tracked unit of an item. A row can
 * match either: a unit's serial or printed code identifies that unit, an
 * item's identifiers identify the item.
 */

export type RowInput = {
  id: string;
  rowNumber: number;
  assetTag: string | null;
  serial: string | null;
  epc: string | null;
  bindexCode: string | null;
  name: string | null;
  model: string | null;
  costCents: number | null;
  locationText: string | null;
  /** The register location resolved to a location here, when it could be. */
  registerLocationId: string | null;
  /** More than one location has the register's location text. */
  locationAmbiguous?: boolean;
};

export type Target = {
  /** "i:<itemId>" for an item, "u:<unitId>" for a unit. */
  key: string;
  itemId: string;
  unitId: string | null;
  name: string;
  model: string | null;
  /** The printed code: the unit's own for a unit. */
  assetCode: string;
  locationId: string | null;
  valueCents: number | null;
  flaggedMissing: boolean;
  serials: string[];
  assetTags: string[];
  epcs: string[];
  /** Inside the company or location subtree the run is scoped to. */
  inScope: boolean;
  /** Item targets only: the item has tracked units, which stand for it. */
  hasUnits: boolean;
};

export const itemKey = (itemId: string) => `i:${itemId}`;
export const unitKey = (unitId: string) => `u:${unitId}`;

export type KeyIndex = Record<MatchMethod, Map<string, string[]>>;

export function buildKeyIndex(targets: Iterable<Target>): KeyIndex {
  const index: KeyIndex = {
    asset_tag: new Map(),
    serial: new Map(),
    epc: new Map(),
    asset_code: new Map(),
  };
  const add = (method: MatchMethod, value: string | null, key: string) => {
    if (!value) return;
    const list = index[method].get(value);
    if (!list) index[method].set(value, [key]);
    else if (!list.includes(key)) list.push(key);
  };
  for (const t of targets) {
    for (const v of t.assetTags) add("asset_tag", normKey(v), t.key);
    for (const v of t.serials) add("serial", normKey(v), t.key);
    for (const v of t.epcs) add("epc", normalizeEpc(v), t.key);
    add("asset_code", normKey(t.assetCode), t.key);
  }
  return index;
}

export type RowMatch = {
  targetKey: string | null;
  method: MatchMethod | null;
  /** Assets that share the key the row was matched on, when more than one. */
  ambiguous: string[];
  /** Other keys on the row that point at a different asset. */
  crossRefs: { method: MatchMethod; value: string; keys: string[] }[];
};

const METHOD_ORDER: MatchMethod[] = ["asset_tag", "serial", "epc", "asset_code"];

function rowKeys(row: RowInput): Record<MatchMethod, string[]> {
  const codes = [normKey(row.bindexCode), normKey(row.assetTag)].filter((v): v is string => !!v);
  return {
    asset_tag: [normKey(row.assetTag)].filter((v): v is string => !!v),
    serial: [normKey(row.serial)].filter((v): v is string => !!v),
    epc: [normalizeEpc(row.epc)].filter((v): v is string => !!v),
    asset_code: [...new Set(codes)],
  };
}

/**
 * The same physical thing can answer to both an item key and one of its unit
 * keys (a serial recorded on the item and on the unit). Those are one asset,
 * and the unit is the more specific answer.
 */
function collapse(keys: string[], targets: Map<string, Target>): string[] {
  const byItem = new Map<string, string[]>();
  for (const k of keys) {
    const t = targets.get(k);
    if (!t) continue;
    const list = byItem.get(t.itemId) ?? [];
    list.push(k);
    byItem.set(t.itemId, list);
  }
  const out: string[] = [];
  for (const [itemId, list] of byItem) {
    const units = list.filter((k) => k.startsWith("u:"));
    out.push(units.length === 1 ? units[0]! : itemKey(itemId));
  }
  return out;
}

function lookup(index: KeyIndex, method: MatchMethod, values: string[], targets: Map<string, Target>): string[] {
  const keys = new Set<string>();
  for (const v of values) for (const k of index[method].get(v) ?? []) keys.add(k);
  return collapse([...keys], targets);
}

/**
 * Exact matching, in order: asset tag, serial, RFID/EPC, then a printed code.
 * The first key that finds something decides. When that key is on several
 * assets, a later key may pick one of them; the row is a duplicate either way.
 */
export function matchExact(rows: RowInput[], index: KeyIndex, targets: Map<string, Target>): Map<string, RowMatch> {
  const out = new Map<string, RowMatch>();
  for (const row of rows) {
    const keys = rowKeys(row);
    const found = METHOD_ORDER.map((method) => ({ method, keys: lookup(index, method, keys[method], targets) }));
    let match: RowMatch = { targetKey: null, method: null, ambiguous: [], crossRefs: [] };
    const first = found.find((f) => f.keys.length > 0);
    if (first) {
      if (first.keys.length === 1) {
        match = { targetKey: first.keys[0]!, method: first.method, ambiguous: [], crossRefs: [] };
      } else {
        const narrowed = found
          .slice(found.indexOf(first) + 1)
          .find((f) => f.keys.length === 1 && first.keys.includes(f.keys[0]!));
        match = {
          targetKey: narrowed?.keys[0] ?? null,
          method: narrowed ? narrowed.method : null,
          ambiguous: first.keys,
          crossRefs: [],
        };
      }
    }
    if (match.targetKey) {
      const matched = targets.get(match.targetKey)!;
      for (const f of found) {
        const elsewhere = f.keys.filter((k) => targets.get(k)!.itemId !== matched.itemId);
        if (elsewhere.length) {
          match.crossRefs.push({ method: f.method, value: keys[f.method][0]!, keys: elsewhere });
        }
      }
    }
    out.set(row.id, match);
  }
  return out;
}

export type Proposal = { itemId: string; score: number };

export type ClassifiedResult = {
  rowId: string | null;
  targetKey: string | null;
  itemId: string | null;
  unitId: string | null;
  classes: ReconcileClass[];
  matchMethod: MatchMethod | null;
  registerLocationId: string | null;
  bindexLocationId: string | null;
  proposal: Proposal | null;
  conflicts: ResultConflict[];
  notes: string[];
};

export type ClassCounts = Record<ReconcileClass, number> & {
  rows: number;
  assetsInScope: number;
  matchedRows: number;
  proposals: number;
};

export const CLASS_ORDER: ReconcileClass[] = [
  "matched",
  "misplaced",
  "conflict",
  "register_only",
  "bindex_only",
  "duplicate",
  "flagged_missing",
];

const METHOD_LABEL: Record<MatchMethod, string> = {
  asset_tag: "Asset tag",
  serial: "Serial",
  epc: "EPC",
  asset_code: "Printed code",
};

const rowList = (numbers: number[]) =>
  numbers.length === 1 ? `row ${numbers[0]}` : `rows ${numbers.join(", ")}`;

/** Model numbers are written many ways; one containing the other is the same model. */
function sameModel(a: string, b: string): boolean {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}

function conflictsFor(row: RowInput, t: Target): ResultConflict[] {
  const out: ResultConflict[] = [];
  const tag = normKey(row.assetTag);
  if (tag && t.assetTags.length && !t.assetTags.some((v) => normKey(v) === tag) && tag !== normKey(t.assetCode)) {
    out.push({ field: "assetTag", register: row.assetTag, bindex: t.assetTags.join(", ") });
  }
  const serial = normKey(row.serial);
  if (serial && t.serials.length && !t.serials.some((v) => normKey(v) === serial)) {
    out.push({ field: "serial", register: row.serial, bindex: t.serials.join(", ") });
  }
  const epc = normalizeEpc(row.epc);
  if (epc && t.epcs.length && !t.epcs.some((v) => normalizeEpc(v) === epc)) {
    out.push({ field: "epc", register: row.epc, bindex: t.epcs.join(", ") });
  }
  if (row.model && t.model && !sameModel(row.model, t.model)) {
    out.push({ field: "model", register: row.model, bindex: t.model });
  }
  if (row.costCents != null && t.valueCents != null && row.costCents !== t.valueCents) {
    out.push({ field: "cost", register: String(row.costCents), bindex: String(t.valueCents) });
  }
  return out;
}

/**
 * Classify every row and every in-scope asset. A row can carry several
 * classes (misplaced and in conflict, say); "matched" means matched with
 * nothing to fix. Fuzzy proposals never make a match: a proposed row stays
 * register-only and its proposed item stays unregistered until a person links
 * them.
 */
export function classify(
  rows: RowInput[],
  matches: Map<string, RowMatch>,
  targets: Map<string, Target>,
  proposals: Map<string, Proposal> = new Map(),
): { results: ClassifiedResult[]; counts: ClassCounts } {
  const code = (key: string) => targets.get(key)?.assetCode ?? key;

  // Rows that repeat a key within the register itself.
  const seen = new Map<string, number[]>();
  const keyed = new Map<string, string[]>();
  for (const row of rows) {
    const entries: [string, string | null][] = [
      ["Asset tag", normKey(row.assetTag)],
      ["Serial", normKey(row.serial)],
      ["EPC", normalizeEpc(row.epc)],
      ["Printed code", normKey(row.bindexCode)],
    ];
    const mine: string[] = [];
    for (const [label, value] of entries) {
      if (!value) continue;
      const k = `${label}\u0000${value}`;
      seen.set(k, [...(seen.get(k) ?? []), row.rowNumber]);
      mine.push(k);
    }
    keyed.set(row.id, mine);
  }

  const claims = new Map<string, RowInput[]>();
  for (const row of rows) {
    const m = matches.get(row.id);
    if (m?.targetKey) claims.set(m.targetKey, [...(claims.get(m.targetKey) ?? []), row]);
  }

  const results: ClassifiedResult[] = [];
  for (const row of rows) {
    const m = matches.get(row.id) ?? { targetKey: null, method: null, ambiguous: [], crossRefs: [] };
    const classes = new Set<ReconcileClass>();
    const notes: string[] = [];

    for (const k of keyed.get(row.id) ?? []) {
      const others = (seen.get(k) ?? []).filter((n) => n !== row.rowNumber);
      if (others.length) {
        const [label, value] = k.split("\u0000");
        classes.add("duplicate");
        notes.push(`${label} ${value} is also on ${rowList(others)} of the register.`);
      }
    }
    if (m.ambiguous.length) {
      classes.add("duplicate");
      notes.push(`The same key is on ${m.ambiguous.length} records here: ${m.ambiguous.map(code).join(", ")}.`);
    }

    let conflicts: ResultConflict[] = [];
    const t = m.targetKey ? targets.get(m.targetKey) : undefined;
    if (t) {
      const claimants = (claims.get(t.key) ?? []).filter((r) => r.id !== row.id);
      if (claimants.length) {
        classes.add("duplicate");
        const verb = claimants.length === 1 ? "also matches" : "also match";
        notes.push(`Register ${rowList(claimants.map((r) => r.rowNumber))} ${verb} ${t.assetCode}.`);
      }
      for (const x of m.crossRefs) {
        notes.push(`${METHOD_LABEL[x.method]} ${x.value} is recorded on ${x.keys.map(code).join(", ")}.`);
      }
      if (row.registerLocationId && row.registerLocationId !== t.locationId) classes.add("misplaced");
      conflicts = conflictsFor(row, t);
      if (conflicts.length) classes.add("conflict");
      if (t.flaggedMissing) classes.add("flagged_missing");
      if (!t.inScope) notes.push("Matched outside the scope of this run.");
      if (classes.size === 0) classes.add("matched");
    } else {
      classes.add("register_only");
    }
    if (row.locationText && !row.registerLocationId) {
      notes.push(
        row.locationAmbiguous
          ? `Location "${row.locationText}" fits more than one location here; map it to one.`
          : `Location "${row.locationText}" is not mapped to a location here.`,
      );
    }

    results.push({
      rowId: row.id,
      targetKey: t?.key ?? null,
      itemId: t?.itemId ?? null,
      unitId: t?.unitId ?? null,
      classes: CLASS_ORDER.filter((c) => classes.has(c)),
      matchMethod: t ? m.method : null,
      registerLocationId: row.registerLocationId,
      bindexLocationId: t?.locationId ?? null,
      proposal: t ? null : proposals.get(row.id) ?? null,
      conflicts,
      notes,
    });
  }

  // Assets nobody in the register accounts for. An item with tracked units is
  // accounted for by its units, unless a row names the item itself.
  let assetsInScope = 0;
  for (const t of targets.values()) {
    if (!t.inScope) continue;
    if (t.unitId === null && t.hasUnits) continue;
    assetsInScope++;
    if (claims.has(t.key)) continue;
    if (t.unitId !== null && claims.has(itemKey(t.itemId))) continue;
    const classes: ReconcileClass[] = ["bindex_only"];
    if (t.flaggedMissing) classes.push("flagged_missing");
    results.push({
      rowId: null,
      targetKey: t.key,
      itemId: t.itemId,
      unitId: t.unitId,
      classes,
      matchMethod: null,
      registerLocationId: null,
      bindexLocationId: t.locationId,
      proposal: null,
      conflicts: [],
      notes: [],
    });
  }

  const counts = Object.fromEntries(CLASS_ORDER.map((c) => [c, 0])) as ClassCounts;
  counts.rows = rows.length;
  counts.assetsInScope = assetsInScope;
  counts.matchedRows = 0;
  counts.proposals = 0;
  for (const r of results) {
    for (const c of r.classes) counts[c]++;
    if (r.rowId && r.targetKey) counts.matchedRows++;
    if (r.proposal) counts.proposals++;
  }
  return { results, counts };
}
