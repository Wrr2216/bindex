import { pool } from "../../db/client";
import type { HighValueMode, ServiceRecordRow, ValuationProfileRow } from "../../db/tables/valuation";
import { getConfig } from "../config";
import { declarationsForItem } from "./declarations";
import { listDue, type DueList } from "./digest";
import { today } from "./parse";
import { listProfiles, listServicePlans, listServiceRecords, type ServicePlan } from "./profiles";
import { receiptsForItem, type ReceiptSummary } from "./receipts";
import { valuedRecords, type ValuedRecord } from "./records";
import { isHighValue, lifeFor, straightLine, warrantyState, type Depreciation } from "./schedule";
import { getValuationSettings } from "./settings";
import { listValuations, loadOwner, type Valuation } from "./valuations";

/** Read models for the item panel and the Valuation overview. */

export type RecordSummary = {
  /** Null for the item itself. */
  unitId: string | null;
  label: string;
  valueCents: number | null;
  highValue: boolean;
  highValueMode: HighValueMode;
  profile: ValuationProfileRow | null;
  latest: Valuation | null;
  warranty: ReturnType<typeof warrantyState>;
  depreciation: Depreciation | null;
  lifeYears: number;
};

export type ItemValuation = {
  itemId: string;
  currency: string;
  thresholdCents: number;
  /** An item with units is valued unit by unit. */
  hasUnits: boolean;
  records: RecordSummary[];
  valuations: Valuation[];
  servicePlans: ServicePlan[];
  serviceRecords: ServiceRecordRow[];
  receipts: ReceiptSummary[];
  declarations: Awaited<ReturnType<typeof declarationsForItem>>;
};

export async function getItemValuation(itemId: string): Promise<ItemValuation> {
  const owner = await loadOwner(itemId);
  const [config, settings, profiles, valuations, servicePlans, serviceRecords, receipts, declarations, units] = await Promise.all([
    getConfig(),
    getValuationSettings(),
    listProfiles(itemId),
    listValuations(itemId),
    listServicePlans(itemId),
    listServiceRecords(itemId),
    receiptsForItem(itemId),
    declarationsForItem(itemId),
    pool.query<{ id: string; label: string | null; serial: string | null; assetCode: string; valueCents: number | null }>(
      `SELECT id, label, serial, asset_code AS "assetCode", value_cents::float8 AS "valueCents"
         FROM item_units WHERE item_id = $1 ORDER BY created_at, id`,
      [itemId],
    ),
  ]);
  const day = today();
  const life = lifeFor(owner.item.category, settings.depreciation);
  const summarize = (unitId: string | null, label: string, valueCents: number | null): RecordSummary => {
    const profile = profiles.find((p) => (p.unitId ?? null) === unitId) ?? null;
    // A unit without its own purchase date or warranty was bought with the item.
    const itemProfile = profiles.find((p) => p.unitId === null) ?? null;
    const mode = profile?.highValue ?? "auto";
    const purchaseDate = profile?.purchaseDate ?? itemProfile?.purchaseDate ?? null;
    return {
      unitId,
      label,
      valueCents,
      highValue: isHighValue(mode, valueCents, settings.highValueThresholdCents),
      highValueMode: mode,
      profile,
      latest: valuations.find((v) => (v.unitId ?? null) === unitId) ?? null,
      warranty: warrantyState(profile?.warrantyEnds ?? (unitId ? itemProfile?.warrantyEnds : null) ?? null, day, settings.warrantyAlertDays),
      depreciation: straightLine(profile?.purchaseCents ?? valueCents, purchaseDate, day, life, settings.depreciation.salvagePercent),
      lifeYears: life,
    };
  };
  const records = [
    summarize(null, owner.item.name, owner.item.valueCents),
    ...units.rows.map((u) => summarize(u.id, u.label?.trim() || u.serial?.trim() || u.assetCode, u.valueCents)),
  ];
  return {
    itemId,
    currency: config.currency,
    thresholdCents: settings.highValueThresholdCents,
    hasUnits: units.rows.length > 0,
    records,
    valuations,
    servicePlans,
    serviceRecords,
    receipts,
    declarations,
  };
}

export type Overview = {
  currency: string;
  thresholdCents: number;
  totals: { records: number; valued: number; highValue: number; valueCents: number; highValueCents: number; aiEstimated: number };
  /** The most valuable high-value records, highest first. */
  highValue: (ValuedRecord & { highValue: true })[];
  due: DueList;
  recent: (Valuation & { itemName: string })[];
  drafts: { receipts: number; declarations: number };
};

export async function getOverview(): Promise<Overview> {
  const [config, settings, records, due, recent, drafts] = await Promise.all([
    getConfig(),
    getValuationSettings(),
    valuedRecords({ limit: 20_000 }),
    listDue(),
    pool.query(
      `SELECT v.id, v.item_id AS "itemId", v.unit_id AS "unitId", v.value_cents::float8 AS "valueCents",
              v.previous_cents::float8 AS "previousCents", v.currency, v.source, v.basis, v.confidence,
              v.low_cents::float8 AS "lowCents", v.high_cents::float8 AS "highCents", v.valued_on::text AS "valuedOn",
              v.details, v.created_by AS "createdBy", v.created_at AS "createdAt", u.name AS "createdByName", i.name AS "itemName"
         FROM valuations v JOIN items i ON i.id = v.item_id LEFT JOIN users u ON u.oid = v.created_by
        ORDER BY v.created_at DESC LIMIT 20`,
    ),
    pool.query<{ receipts: number; declarations: number }>(
      `SELECT (SELECT count(*)::int FROM receipts WHERE status = 'draft') AS receipts,
              (SELECT count(*)::int FROM hv_declarations WHERE status = 'draft') AS declarations`,
    ),
  ]);
  const threshold = settings.highValueThresholdCents;
  const high = records.filter((r) => isHighValue(r.highValueMode, r.valueCents, threshold));
  return {
    currency: config.currency,
    thresholdCents: threshold,
    totals: {
      records: records.length,
      valued: records.filter((r) => r.valueCents !== null).length,
      highValue: high.length,
      valueCents: records.reduce((n, r) => n + (r.valueCents ?? 0), 0),
      highValueCents: high.reduce((n, r) => n + (r.valueCents ?? 0), 0),
      aiEstimated: records.filter((r) => r.lastSource === "ai").length,
    },
    highValue: high
      .sort((a, b) => (b.valueCents ?? 0) - (a.valueCents ?? 0))
      .slice(0, 50)
      .map((r) => ({ ...r, highValue: true as const })),
    due,
    recent: recent.rows,
    drafts: drafts.rows[0] ?? { receipts: 0, declarations: 0 },
  };
}
