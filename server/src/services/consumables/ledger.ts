import { badRequest } from "../../lib/errors";
import type { StockReason } from "../../db/tables/consumables";

/**
 * The rules for what a stock movement does, kept free of the database so they
 * can be tested exhaustively. The service reads what it needs (the level on
 * file for a count), asks for a plan, and applies exactly the level changes
 * the plan lists, together with the movement row, in one transaction.
 *
 * Every movement stores a positive quantity. Which way it went is carried by
 * the location columns: stock arrives at `toLocationId` and leaves
 * `fromLocationId`. That is what makes "the level at a location equals the sum
 * of its movements" something a query can check.
 */

export const STOCK_REASONS = [
  "receive",
  "issue",
  "return",
  "transfer",
  "consume",
  "adjust",
  "count",
] as const satisfies readonly StockReason[];

/** Entity kinds offered as holders of supplies and equipment. */
export const HOLDER_KINDS = ["crew", "vehicle", "branch"] as const;

export type MovementInput = {
  reason: StockReason;
  /** Receive, issue, return, consume, transfer. */
  qty?: number | null;
  /** Adjust: signed change. */
  delta?: number | null;
  /** Count: what was physically found. */
  countedQty?: number | null;
  /** Count: what was on file, read by the service under a row lock. */
  expectedQty?: number | null;
  /** The one location involved; the source of a transfer. */
  locationId?: string | null;
  /** The destination of a transfer. */
  toLocationId?: string | null;
  holderId?: string | null;
};

export type LevelChange = { locationId: string; delta: number };

export type MovementPlan = {
  reason: StockReason;
  qty: number;
  fromLocationId: string | null;
  toLocationId: string | null;
  holderId: string | null;
  /** What this does to the holder's outstanding balance. */
  holderDelta: number;
  levelChanges: LevelChange[];
  /** Only an administrator's adjustment may take a level below zero. */
  mayGoNegative: boolean;
  expectedQty: number | null;
  countedQty: number | null;
};

// Three decimal places matches numeric(14,3) in the database, and rounding
// here keeps 0.1 + 0.2 from turning into a level that never counts to zero.
const SCALE = 1000;
export const roundQty = (n: number): number => Math.round(n * SCALE) / SCALE;
const MAX_QTY = 99_999_999_999;

/** Parse a numeric column value (node-postgres returns numeric as a string). */
export function toQty(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? roundQty(n) : 0;
}

/** Same as toQty, keeping null as null for optional settings. */
export const toQtyOrNull = (value: string | number | null | undefined): number | null =>
  value === null || value === undefined || value === "" ? null : toQty(value);

function positive(value: number | null | undefined, what: string): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw badRequest(`Enter a quantity to ${what}.`);
  }
  const qty = roundQty(value);
  if (qty <= 0) throw badRequest(`The quantity to ${what} has to be more than zero.`);
  if (qty > MAX_QTY) throw badRequest("That quantity is too large.");
  return qty;
}

function need(value: string | null | undefined, message: string): string {
  if (!value) throw badRequest(message);
  return value;
}

/** Work out what a movement does, or say why it cannot happen. */
export function planMovement(input: MovementInput): MovementPlan {
  const base = {
    reason: input.reason,
    fromLocationId: null as string | null,
    toLocationId: null as string | null,
    holderId: null as string | null,
    holderDelta: 0,
    mayGoNegative: false,
    expectedQty: null as number | null,
    countedQty: null as number | null,
  };

  switch (input.reason) {
    case "receive": {
      const qty = positive(input.qty, "receive");
      const to = need(input.locationId, "Pick where the stock is being received.");
      if (input.holderId) {
        throw badRequest("Stock coming back from a crew, truck or branch is a return, not a receipt.");
      }
      return { ...base, qty, toLocationId: to, levelChanges: [{ locationId: to, delta: qty }] };
    }
    case "issue": {
      const qty = positive(input.qty, "issue");
      const from = need(input.locationId, "Pick where the stock is being issued from.");
      const holder = need(input.holderId, "Pick who the stock is being issued to.");
      return {
        ...base,
        qty,
        fromLocationId: from,
        holderId: holder,
        holderDelta: qty,
        levelChanges: [{ locationId: from, delta: -qty }],
      };
    }
    case "return": {
      const qty = positive(input.qty, "return");
      const holder = need(input.holderId, "Pick who is returning the stock.");
      const to = need(input.locationId, "Pick where the returned stock is going.");
      return {
        ...base,
        qty,
        toLocationId: to,
        holderId: holder,
        holderDelta: -qty,
        levelChanges: [{ locationId: to, delta: qty }],
      };
    }
    case "consume": {
      const qty = positive(input.qty, "record as used");
      // Used straight off a shelf: the location goes down, and a holder, when
      // given, is only who used it. Used out of what a holder was issued: the
      // holder's balance goes down instead.
      if (input.locationId) {
        return {
          ...base,
          qty,
          fromLocationId: input.locationId,
          holderId: input.holderId ?? null,
          levelChanges: [{ locationId: input.locationId, delta: -qty }],
        };
      }
      const holder = need(
        input.holderId,
        "Pick the location it was used from, or who used it out of what they were issued.",
      );
      return { ...base, qty, holderId: holder, holderDelta: -qty, levelChanges: [] };
    }
    case "transfer": {
      const qty = positive(input.qty, "transfer");
      const from = need(input.locationId, "Pick where the stock is moving from.");
      const to = need(input.toLocationId, "Pick where the stock is moving to.");
      if (from === to) throw badRequest("A transfer needs two different locations.");
      if (input.holderId) {
        throw badRequest("Stock going to a crew, truck or branch is an issue, not a transfer.");
      }
      return {
        ...base,
        qty,
        fromLocationId: from,
        toLocationId: to,
        levelChanges: [
          { locationId: from, delta: -qty },
          { locationId: to, delta: qty },
        ],
      };
    }
    case "adjust": {
      const loc = need(input.locationId, "Pick the location to adjust.");
      const raw = input.delta;
      if (raw === null || raw === undefined || !Number.isFinite(raw)) {
        throw badRequest("Enter how much to add or remove.");
      }
      const delta = roundQty(raw);
      if (delta === 0) throw badRequest("An adjustment of zero changes nothing.");
      if (Math.abs(delta) > MAX_QTY) throw badRequest("That quantity is too large.");
      return {
        ...base,
        qty: Math.abs(delta),
        fromLocationId: delta < 0 ? loc : null,
        toLocationId: delta > 0 ? loc : null,
        levelChanges: [{ locationId: loc, delta }],
        mayGoNegative: true,
      };
    }
    case "count": {
      const loc = need(input.locationId, "Pick the location being counted.");
      const counted = input.countedQty;
      if (counted === null || counted === undefined || !Number.isFinite(counted)) {
        throw badRequest("Enter the quantity counted.");
      }
      const countedQty = roundQty(counted);
      if (countedQty < 0) throw badRequest("A count cannot be below zero.");
      if (countedQty > MAX_QTY) throw badRequest("That quantity is too large.");
      const expectedQty = roundQty(input.expectedQty ?? 0);
      const variance = roundQty(countedQty - expectedQty);
      // A count that matches is still recorded, so "last counted" is known; it
      // sits on the receiving side with a quantity of zero.
      return {
        ...base,
        qty: Math.abs(variance),
        fromLocationId: variance < 0 ? loc : null,
        toLocationId: variance >= 0 ? loc : null,
        levelChanges: variance === 0 ? [] : [{ locationId: loc, delta: variance }],
        expectedQty,
        countedQty,
      };
    }
    default:
      throw badRequest(`Unknown movement "${String((input as { reason: unknown }).reason)}".`);
  }
}

/** A stored movement, reduced to what affects levels and balances. */
export type LedgerRow = {
  itemId: string;
  qty: number;
  fromLocationId: string | null;
  toLocationId: string | null;
  holderId: string | null;
  holderDelta: number;
};

const key = (a: string, b: string) => `${a}|${b}`;

/**
 * Rebuild stock levels (item|location) and holder balances (item|holder) from
 * movements alone. Used to prove the stored levels never drift from history.
 */
export function replay(rows: LedgerRow[]): {
  levels: Map<string, number>;
  holders: Map<string, number>;
} {
  const levels = new Map<string, number>();
  const holders = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, d: number) =>
    m.set(k, roundQty((m.get(k) ?? 0) + d));
  for (const r of rows) {
    if (r.toLocationId) bump(levels, key(r.itemId, r.toLocationId), r.qty);
    if (r.fromLocationId) bump(levels, key(r.itemId, r.fromLocationId), -r.qty);
    if (r.holderId && r.holderDelta !== 0) bump(holders, key(r.itemId, r.holderId), r.holderDelta);
  }
  return { levels, holders };
}

/** True when a level has reached the point where it should be reordered. */
export function isLow(qty: number, reorderPoint: number | null): boolean {
  return reorderPoint !== null && qty <= reorderPoint;
}

/** Quantity for people: no trailing zeros, at most three decimals. */
export function formatQty(n: number): string {
  return String(roundQty(n));
}
