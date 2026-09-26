import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

// The modules read the environment when they load, so the minimum required
// configuration has to exist first. Nothing here touches the database.
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Ledger = typeof import("../src/services/consumables/ledger");
type Digest = typeof import("../src/services/consumables/digest");
type Resolve = typeof import("../src/services/consumables/resolve");
let ledger: Ledger;
let digest: Digest;
let resolve: Resolve;

before(async () => {
  ledger = await import("../src/services/consumables/ledger");
  digest = await import("../src/services/consumables/digest");
  resolve = await import("../src/services/consumables/resolve");
});

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const CREW = "cccccccc-0000-0000-0000-000000000003";
const TAPE = "dddddddd-0000-0000-0000-000000000004";

describe("planMovement", () => {
  it("receives into one location", () => {
    const p = ledger.planMovement({ reason: "receive", qty: 12, locationId: A });
    assert.equal(p.qty, 12);
    assert.equal(p.toLocationId, A);
    assert.equal(p.fromLocationId, null);
    assert.deepEqual(p.levelChanges, [{ locationId: A, delta: 12 }]);
    assert.equal(p.holderDelta, 0);
  });

  it("issues out of a location onto a holder's balance", () => {
    const p = ledger.planMovement({ reason: "issue", qty: 5, locationId: A, holderId: CREW });
    assert.deepEqual(p.levelChanges, [{ locationId: A, delta: -5 }]);
    assert.equal(p.fromLocationId, A);
    assert.equal(p.holderId, CREW);
    assert.equal(p.holderDelta, 5);
  });

  it("returns off a holder's balance into a location", () => {
    const p = ledger.planMovement({ reason: "return", qty: 2, locationId: B, holderId: CREW });
    assert.deepEqual(p.levelChanges, [{ locationId: B, delta: 2 }]);
    assert.equal(p.toLocationId, B);
    assert.equal(p.holderDelta, -2);
  });

  it("consumes from a shelf, keeping the holder only as who used it", () => {
    const p = ledger.planMovement({ reason: "consume", qty: 1, locationId: A, holderId: CREW });
    assert.deepEqual(p.levelChanges, [{ locationId: A, delta: -1 }]);
    assert.equal(p.holderId, CREW);
    assert.equal(p.holderDelta, 0);
  });

  it("consumes out of what a holder was issued without touching any shelf", () => {
    const p = ledger.planMovement({ reason: "consume", qty: 3, holderId: CREW });
    assert.deepEqual(p.levelChanges, []);
    assert.equal(p.holderDelta, -3);
    assert.equal(p.fromLocationId, null);
  });

  it("transfers between two different locations", () => {
    const p = ledger.planMovement({ reason: "transfer", qty: 4, locationId: A, toLocationId: B });
    assert.deepEqual(p.levelChanges, [
      { locationId: A, delta: -4 },
      { locationId: B, delta: 4 },
    ]);
    assert.throws(
      () => ledger.planMovement({ reason: "transfer", qty: 4, locationId: A, toLocationId: A }),
      /two different locations/,
    );
  });

  it("lets only an adjustment go negative, and in either direction", () => {
    const down = ledger.planMovement({ reason: "adjust", delta: -7, locationId: A });
    assert.equal(down.mayGoNegative, true);
    assert.equal(down.qty, 7);
    assert.equal(down.fromLocationId, A);
    assert.equal(down.toLocationId, null);
    const up = ledger.planMovement({ reason: "adjust", delta: 2.5, locationId: A });
    assert.equal(up.toLocationId, A);
    assert.equal(up.qty, 2.5);
    for (const reason of ["receive", "issue", "return", "consume", "transfer", "count"] as const) {
      const p = ledger.planMovement({
        reason,
        qty: 1,
        countedQty: 1,
        locationId: A,
        toLocationId: B,
        holderId: reason === "issue" || reason === "return" ? CREW : null,
      });
      assert.equal(p.mayGoNegative, false, reason);
    }
    assert.throws(() => ledger.planMovement({ reason: "adjust", delta: 0, locationId: A }), /zero/);
  });

  it("turns a count into the variance against what was on file", () => {
    const short = ledger.planMovement({ reason: "count", locationId: A, countedQty: 8, expectedQty: 10 });
    assert.equal(short.qty, 2);
    assert.equal(short.fromLocationId, A);
    assert.deepEqual(short.levelChanges, [{ locationId: A, delta: -2 }]);
    assert.equal(short.expectedQty, 10);
    assert.equal(short.countedQty, 8);

    const over = ledger.planMovement({ reason: "count", locationId: A, countedQty: 11, expectedQty: 10 });
    assert.deepEqual(over.levelChanges, [{ locationId: A, delta: 1 }]);
    assert.equal(over.toLocationId, A);

    // A matching count is still recorded, with nothing to change.
    const exact = ledger.planMovement({ reason: "count", locationId: A, countedQty: 10, expectedQty: 10 });
    assert.equal(exact.qty, 0);
    assert.equal(exact.toLocationId, A);
    assert.deepEqual(exact.levelChanges, []);

    assert.throws(
      () => ledger.planMovement({ reason: "count", locationId: A, countedQty: -1, expectedQty: 0 }),
      /below zero/,
    );
  });

  it("rejects what cannot happen, saying what is missing", () => {
    const cases: [Parameters<Ledger["planMovement"]>[0], RegExp][] = [
      [{ reason: "receive", qty: 0, locationId: A }, /more than zero/],
      [{ reason: "receive", qty: -1, locationId: A }, /more than zero/],
      [{ reason: "receive", qty: Number.NaN, locationId: A }, /Enter a quantity/],
      [{ reason: "receive", qty: 1 }, /where the stock is being received/],
      [{ reason: "receive", qty: 1, locationId: A, holderId: CREW }, /is a return/],
      [{ reason: "issue", qty: 1, locationId: A }, /who the stock is being issued to/],
      [{ reason: "issue", qty: 1, holderId: CREW }, /issued from/],
      [{ reason: "return", qty: 1, locationId: A }, /who is returning/],
      [{ reason: "return", qty: 1, holderId: CREW }, /returned stock is going/],
      [{ reason: "consume", qty: 1 }, /location it was used from/],
      [{ reason: "transfer", qty: 1, locationId: A }, /moving to/],
      [{ reason: "transfer", qty: 1, locationId: A, toLocationId: B, holderId: CREW }, /is an issue/],
      [{ reason: "count", locationId: A }, /quantity counted/],
      [{ reason: "adjust", locationId: A }, /how much/],
    ];
    for (const [input, message] of cases) {
      assert.throws(() => ledger.planMovement(input), (err: Error & { status?: number }) => {
        assert.equal(err.status, 400, JSON.stringify(input));
        assert.match(err.message, message);
        return true;
      });
    }
  });

  it("rounds to three decimals so fractions count back to zero", () => {
    const p = ledger.planMovement({ reason: "receive", qty: 0.1 + 0.2, locationId: A });
    assert.equal(p.qty, 0.3);
    assert.equal(ledger.roundQty(1.23456), 1.235);
    assert.equal(ledger.toQty("12.500"), 12.5);
    assert.equal(ledger.toQty(null), 0);
    assert.equal(ledger.toQtyOrNull(null), null);
    assert.equal(ledger.formatQty(3), "3");
    assert.equal(ledger.formatQty(2.5), "2.5");
  });
});

describe("replay", () => {
  // Apply random valid movements to an in-memory store exactly the way the
  // service does (a level change per plan, refusing to go negative), and check
  // that rebuilding from the movements alone lands on the same levels.
  it("rebuilds the same levels and balances as applying each plan", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const locs = [A, B];
    const levels = new Map<string, number>();
    const balance = new Map<string, number>();
    const rows: Parameters<Ledger["replay"]>[0] = [];
    const k = (a: string, b: string) => `${a}|${b}`;

    for (let i = 0; i < 2000; i++) {
      const reason = ledger.STOCK_REASONS[Math.floor(rand() * ledger.STOCK_REASONS.length)]!;
      const loc = locs[Math.floor(rand() * 2)]!;
      const other = loc === A ? B : A;
      const qty = Math.round(rand() * 5000) / 1000 + 0.001;
      let plan;
      try {
        plan = ledger.planMovement({
          reason,
          qty,
          delta: rand() < 0.5 ? -qty : qty,
          countedQty: Math.round(rand() * 10),
          expectedQty: levels.get(k(TAPE, loc)) ?? 0,
          locationId: reason === "consume" && rand() < 0.5 ? null : loc,
          toLocationId: other,
          holderId: reason === "issue" || reason === "return" || reason === "consume" ? CREW : null,
        });
      } catch {
        continue;
      }
      // The guards the service applies in SQL.
      const next = new Map(levels);
      let ok = true;
      for (const c of plan.levelChanges) {
        const v = ledger.roundQty((next.get(k(TAPE, c.locationId)) ?? 0) + c.delta);
        if (v < 0 && !plan.mayGoNegative) ok = false;
        next.set(k(TAPE, c.locationId), v);
      }
      const bal = ledger.roundQty((balance.get(k(TAPE, CREW)) ?? 0) + plan.holderDelta);
      if (bal < 0) ok = false;
      if (!ok) continue;
      for (const [key, v] of next) levels.set(key, v);
      if (plan.holderId) balance.set(k(TAPE, CREW), bal);
      rows.push({
        itemId: TAPE,
        qty: plan.qty,
        fromLocationId: plan.fromLocationId,
        toLocationId: plan.toLocationId,
        holderId: plan.holderId,
        holderDelta: plan.holderDelta,
      });
    }

    assert.ok(rows.length > 500, `only ${rows.length} movements were valid`);
    const rebuilt = ledger.replay(rows);
    for (const loc of locs) {
      assert.equal(rebuilt.levels.get(k(TAPE, loc)) ?? 0, levels.get(k(TAPE, loc)) ?? 0, loc);
    }
    assert.equal(rebuilt.holders.get(k(TAPE, CREW)) ?? 0, balance.get(k(TAPE, CREW)) ?? 0);
  });
});

describe("isLow", () => {
  it("is low at or below the reorder point, and never without one", () => {
    assert.equal(ledger.isLow(10, 10), true);
    assert.equal(ledger.isLow(9.5, 10), true);
    assert.equal(ledger.isLow(10.001, 10), false);
    assert.equal(ledger.isLow(0, null), false);
  });
});

describe("low-stock digest", () => {
  const row = (over: Partial<import("../src/services/consumables/digest").LowStockRow>) => ({
    itemId: TAPE,
    itemName: "Packing tape",
    unit: "roll",
    locationId: A,
    locationName: "Warehouse",
    qty: 3,
    reorderPoint: 10,
    reorderQty: 24,
    supplier: "Uline",
    ...over,
  });

  it("uses the server's calendar day", () => {
    assert.equal(digest.dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
    assert.equal(digest.dayKey(new Date(2026, 11, 31, 0, 1)), "2026-12-31");
  });

  it("is due from the configured hour on, and never when switched off", () => {
    assert.equal(digest.isDue(new Date(2026, 0, 5, 6, 59), 7), false);
    assert.equal(digest.isDue(new Date(2026, 0, 5, 7, 0), 7), true);
    assert.equal(digest.isDue(new Date(2026, 0, 5, 23, 0), 7), true);
    assert.equal(digest.isDue(new Date(2026, 0, 5, 23, 0), -1), false);
  });

  it("groups by location, with items stocked nowhere last", () => {
    const d = digest.formatDigest([
      row({ locationId: null, locationName: null, itemName: "Stretch wrap", itemId: "w" }),
      row({ locationId: B, locationName: "Annex" }),
      row({}),
    ]);
    const lines = d.message.split("\n");
    assert.equal(lines[0], "Annex");
    assert.match(lines[1]!, /^- Packing tape: 3 roll \(reorder at 10, order 24 from Uline\)$/);
    assert.equal(lines[2], "Warehouse");
    assert.equal(lines[4], "Not stocked anywhere");
    assert.match(lines[5]!, /Stretch wrap/);
    assert.equal(d.title, "2 supplies low across 2 locations");
  });

  it("fits a push notification and says how many were left off", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      row({ itemId: `i${i}`, itemName: `Item number ${String(i).padStart(3, "0")}` }),
    );
    const d = digest.formatDigest(many);
    assert.ok(d.message.length <= 1024, `message is ${d.message.length} characters`);
    assert.match(d.message, /…and \d+ more\. Open Supplies for the full list\.$/);
    const shown = d.message.split("\n").filter((l) => l.startsWith("- ")).length;
    const rest = Number(d.message.match(/and (\d+) more/)![1]);
    assert.equal(shown + rest, 200);
  });

  it("names a single item in the singular", () => {
    assert.equal(digest.formatDigest([row({})]).title, "1 supply low");
  });
});

describe("parseDeepLink", () => {
  it("reads item, unit and location ids from label URLs", () => {
    const item = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071";
    const unit = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
    assert.deepEqual(resolve.parseDeepLink(`https://inv.example.com/items/${item}`), { itemId: item, unitId: null });
    assert.deepEqual(resolve.parseDeepLink(`https://inv.example.com/items/${item}?unit=${unit}`), {
      itemId: item,
      unitId: unit,
    });
    assert.deepEqual(resolve.parseDeepLink(`https://inv.example.com/locations/${item}`), { locationId: item });
    assert.equal(resolve.parseDeepLink("INV-7F3K2A"), null);
    assert.equal(resolve.parseDeepLink("012345678905"), null);
  });
});
