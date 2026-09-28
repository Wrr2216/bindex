import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { companies, locations } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { getConfig } from "../config";
import { today } from "./parse";
import { valuedRecords, type ValuedRecord } from "./records";
import { isHighValue, lifeFor, straightLine, warrantyState, type Depreciation } from "./schedule";
import { getValuationSettings } from "./settings";

/**
 * The insurance and asset valuation report: every valued record in a place,
 * grouped by location or by company, with its purchase, current value and
 * straight-line book value. Rendered as PDF (reportPdf.ts) or XLSX
 * (reportXlsx.ts) from the same data, so the two never disagree.
 */

export type ReportOptions = {
  locationId?: string | null;
  companyId?: string | null;
  includeSublocations?: boolean;
  groupBy?: "location" | "company";
  highValueOnly?: boolean;
  /** YYYY-MM-DD to depreciate to; today by default. */
  asOf?: string;
};

export type ReportRow = ValuedRecord & {
  group: string;
  highValue: boolean;
  lifeYears: number;
  depreciation: Depreciation | null;
  warranty: ReturnType<typeof warrantyState>;
};

export type ReportGroup = { name: string; rows: ReportRow[]; valueCents: number; costCents: number; bookCents: number };

export type Report = {
  title: string;
  /** Where and what, in words: "Warehouse 3 and everything in it". */
  scope: string;
  asOf: string;
  generatedAt: Date;
  currency: string;
  locale: string;
  appName: string;
  thresholdCents: number;
  salvagePercent: number;
  groups: ReportGroup[];
  totals: { records: number; valued: number; highValue: number; valueCents: number; costCents: number; bookCents: number; aiEstimated: number };
};

const MAX_ROWS = 20_000;

export async function buildReport(opts: ReportOptions): Promise<Report> {
  const [config, settings] = await Promise.all([getConfig(), getValuationSettings()]);
  const scopeParts: string[] = [];
  if (opts.locationId) {
    const [loc] = await db.select({ name: locations.name }).from(locations).where(eq(locations.id, opts.locationId)).limit(1);
    if (!loc) throw notFound("That location no longer exists.");
    scopeParts.push(opts.includeSublocations === false ? loc.name : `${loc.name} and everything in it`);
  }
  if (opts.companyId) {
    const [co] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, opts.companyId)).limit(1);
    if (!co) throw notFound(`That ${config.terms.group.singular.toLowerCase()} no longer exists.`);
    scopeParts.push(co.name);
  }

  const asOf = opts.asOf ?? today();
  const threshold = settings.highValueThresholdCents;
  const records = await valuedRecords({
    locationId: opts.locationId,
    companyId: opts.companyId,
    includeSublocations: opts.includeSublocations,
    limit: MAX_ROWS,
  });

  const unassigned = opts.groupBy === "company" ? `No ${config.terms.group.singular.toLowerCase()}` : `No ${config.terms.location.singular.toLowerCase()}`;
  const rows: ReportRow[] = records
    .map((r) => {
      const lifeYears = lifeFor(r.category, settings.depreciation);
      return {
        ...r,
        group: (opts.groupBy === "company" ? r.companyName : r.locationName) ?? unassigned,
        highValue: isHighValue(r.highValueMode, r.valueCents, threshold),
        lifeYears,
        // Book value runs from what was paid; without a price on file, from the recorded value.
        depreciation: straightLine(r.purchaseCents ?? r.valueCents, r.purchaseDate, asOf, lifeYears, settings.depreciation.salvagePercent),
        warranty: warrantyState(r.warrantyEnds, asOf, settings.warrantyAlertDays),
      };
    })
    .filter((r) => !opts.highValueOnly || r.highValue);

  const byName = new Map<string, ReportGroup>();
  for (const r of rows) {
    let g = byName.get(r.group);
    if (!g) {
      g = { name: r.group, rows: [], valueCents: 0, costCents: 0, bookCents: 0 };
      byName.set(r.group, g);
    }
    g.rows.push(r);
    g.valueCents += r.valueCents ?? 0;
    g.costCents += r.purchaseCents ?? 0;
    g.bookCents += r.depreciation?.bookCents ?? 0;
  }
  const groups = [...byName.values()].sort((a, b) =>
    a.name === unassigned ? 1 : b.name === unassigned ? -1 : a.name.localeCompare(b.name),
  );

  return {
    title: opts.highValueOnly ? "High-value items" : "Valuation report",
    scope: scopeParts.join(" · ") || `All ${config.terms.location.plural.toLowerCase()}`,
    asOf,
    generatedAt: new Date(),
    currency: config.currency,
    locale: config.locale,
    appName: config.appName,
    thresholdCents: threshold,
    salvagePercent: settings.depreciation.salvagePercent,
    groups,
    totals: {
      records: rows.length,
      valued: rows.filter((r) => r.valueCents !== null).length,
      highValue: rows.filter((r) => r.highValue).length,
      valueCents: rows.reduce((n, r) => n + (r.valueCents ?? 0), 0),
      costCents: rows.reduce((n, r) => n + (r.purchaseCents ?? 0), 0),
      bookCents: rows.reduce((n, r) => n + (r.depreciation?.bookCents ?? 0), 0),
      aiEstimated: rows.filter((r) => r.lastSource === "ai").length,
    },
  };
}
