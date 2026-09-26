import { addMonths, daysBetween } from "./parse";

/**
 * Pure date and money arithmetic for warranty, service intervals and
 * depreciation. Kept apart from the database so the edge cases (leap days,
 * hour meters that run backwards, items older than their useful life) are
 * tested directly.
 */

const DAY_MS = 86_400_000;

// ---- Service intervals ------------------------------------------------------

export type ServicePlanLike = {
  intervalDays: number | null;
  intervalHours: number | null;
  startsAt: Date;
  startsHours: number | null;
  lastDoneAt: Date | null;
  lastDoneHours: number | null;
  active: boolean;
};

export type ServiceState = "ok" | "soon" | "overdue" | "inactive";

export type ServiceStatus = {
  state: ServiceState;
  /** When the next service falls due by the calendar, if the plan counts days. */
  dueAt: Date | null;
  /** The meter reading it falls due at, if the plan counts hours. */
  dueHours: number | null;
  /** Days until dueAt (negative when overdue). */
  daysLeft: number | null;
  /** Hours of use left (negative when overdue), when a meter reading is known. */
  hoursLeft: number | null;
  /** Which limit decides the state: whichever comes first. */
  reason: "days" | "hours" | null;
  /** A stable key for the due point, so each one is announced once. */
  dueKey: string;
};

/**
 * Where a plan stands. A plan counting both days and hours is due at whichever
 * comes first. "soon" is within `soonDays` of the date, or within
 * `soonPercent` of the hour interval.
 */
export function serviceStatus(
  plan: ServicePlanLike,
  usageHours: number | null,
  opts: { now?: Date; soonDays: number; soonPercent: number },
): ServiceStatus {
  const now = opts.now ?? new Date();
  const anchorAt = plan.lastDoneAt ?? plan.startsAt;
  const dueAt = plan.intervalDays ? new Date(anchorAt.getTime() + plan.intervalDays * DAY_MS) : null;
  const anchorHours = plan.lastDoneHours ?? plan.startsHours ?? (plan.intervalHours ? 0 : null);
  const dueHours =
    plan.intervalHours && anchorHours !== null ? Math.round((anchorHours + plan.intervalHours) * 100) / 100 : null;

  const daysLeft = dueAt ? Math.floor((dueAt.getTime() - now.getTime()) / DAY_MS) : null;
  const hoursLeft = dueHours !== null && usageHours !== null ? Math.round((dueHours - usageHours) * 100) / 100 : null;
  const dueKey = `${dueAt ? dueAt.toISOString().slice(0, 10) : ""}|${dueHours ?? ""}`;

  if (!plan.active) return { state: "inactive", dueAt, dueHours, daysLeft, hoursLeft, reason: null, dueKey };

  const byDays: ServiceState | null =
    daysLeft === null ? null : dueAt!.getTime() <= now.getTime() ? "overdue" : daysLeft <= opts.soonDays ? "soon" : "ok";
  const byHours: ServiceState | null =
    hoursLeft === null
      ? null
      : hoursLeft <= 0
        ? "overdue"
        : hoursLeft <= (plan.intervalHours ?? 0) * (opts.soonPercent / 100)
          ? "soon"
          : "ok";

  const rank = { overdue: 2, soon: 1, ok: 0, inactive: -1 } as const;
  let state: ServiceState = "ok";
  let reason: ServiceStatus["reason"] = null;
  if (byDays) {
    state = byDays;
    reason = "days";
  }
  if (byHours && (reason === null || rank[byHours] > rank[state])) {
    state = byHours;
    reason = "hours";
  }
  return { state, dueAt, dueHours, daysLeft, hoursLeft, reason, dueKey };
}

// ---- Warranty -----------------------------------------------------------

export type WarrantyState = "active" | "expiring" | "expired" | "none";

export function warrantyState(warrantyEnds: string | null, today: string, alertDays: number): { state: WarrantyState; daysLeft: number | null } {
  if (!warrantyEnds) return { state: "none", daysLeft: null };
  const daysLeft = daysBetween(today, warrantyEnds);
  if (daysLeft < 0) return { state: "expired", daysLeft };
  if (daysLeft <= alertDays) return { state: "expiring", daysLeft };
  return { state: "active", daysLeft };
}

/** The warranty end for a purchase date and a term in months. */
export const warrantyEndFrom = (purchaseDate: string, months: number): string => addMonths(purchaseDate, months);

// ---- Depreciation ---------------------------------------------------------

export type DepreciationSettings = {
  /** Useful life in years when the category has none of its own. */
  defaultLifeYears: number;
  /** What is left at the end of the life, as a percentage of cost. */
  salvagePercent: number;
  /** Useful life per category, matched without regard to case. */
  lifeYearsByCategory: Record<string, number>;
};

export type Depreciation = {
  costCents: number;
  lifeYears: number;
  ageYears: number;
  /** Cost less straight-line depreciation to date, never below salvage. */
  bookCents: number;
  depreciatedCents: number;
  fullyDepreciated: boolean;
};

export function lifeFor(category: string | null | undefined, s: DepreciationSettings): number {
  if (category) {
    const key = Object.keys(s.lifeYearsByCategory).find((k) => k.trim().toLowerCase() === category.trim().toLowerCase());
    if (key) {
      const years = s.lifeYearsByCategory[key]!;
      if (years > 0) return years;
    }
  }
  return s.defaultLifeYears;
}

/**
 * Straight-line depreciation from the purchase date to `asOf`: the cost less
 * salvage, spread evenly over the useful life. Null without a cost or a
 * purchase date, since there is nothing to depreciate from.
 */
export function straightLine(
  costCents: number | null,
  purchaseDate: string | null,
  asOf: string,
  lifeYears: number,
  salvagePercent: number,
): Depreciation | null {
  if (costCents === null || costCents < 0 || !purchaseDate || !(lifeYears > 0)) return null;
  const ageDays = Math.max(0, daysBetween(purchaseDate, asOf));
  const ageYears = ageDays / 365.25;
  const salvage = Math.round((costCents * Math.min(100, Math.max(0, salvagePercent))) / 100);
  const depreciable = costCents - salvage;
  const depreciatedCents = Math.round(depreciable * Math.min(1, ageYears / lifeYears));
  return {
    costCents,
    lifeYears,
    ageYears: Math.round(ageYears * 100) / 100,
    bookCents: costCents - depreciatedCents,
    depreciatedCents,
    fullyDepreciated: ageYears >= lifeYears,
  };
}

// ---- High value -----------------------------------------------------------

/** Whether a record counts as high value: an explicit yes or no wins, otherwise the threshold decides. */
export function isHighValue(mode: "auto" | "yes" | "no" | null | undefined, valueCents: number | null, thresholdCents: number): boolean {
  if (mode === "yes") return true;
  if (mode === "no") return false;
  return thresholdCents > 0 && valueCents !== null && valueCents >= thresholdCents;
}
