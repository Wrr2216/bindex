import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

/**
 * The acceptance checks for consumables, against a real Postgres. They need a
 * database of their own, named by TEST_DATABASE_URL, and are skipped without
 * one (CI has no Postgres). Every row they create is tagged and removed after.
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bindex_test pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "set TEST_DATABASE_URL to run the database tests";
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

type Stock = typeof import("../src/services/consumables/stock");
type Kits = typeof import("../src/services/consumables/kits");
type Low = typeof import("../src/services/consumables/lowstock");
type Ledger = typeof import("../src/services/consumables/ledger");

let stock: Stock;
let kits: Kits;
let low: Low;
let ledger: Ledger;
let dbmod: typeof import("../src/db/client");

const TAG = `t06-${randomUUID().slice(0, 8)}`;
const ADMIN = { oid: `test:${TAG}:admin`, admin: true };
const MEMBER = { oid: `test:${TAG}:member`, admin: false };
const ids = { items: [] as string[], locations: [] as string[], entities: [] as string[] };

async function q<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await dbmod.pool.query(text, params)).rows as T[];
}

async function makeItem(name: string, valueCents: number | null = null): Promise<string> {
  const [row] = await q<{ id: string }>(
    "INSERT INTO items (name, value_cents, created_by) VALUES ($1, $2, $3) RETURNING id",
    [`${TAG} ${name}`, valueCents, ADMIN.oid],
  );
  ids.items.push(row!.id);
  return row!.id;
}
async function makeLocation(name: string): Promise<string> {
  const [row] = await q<{ id: string }>("INSERT INTO locations (name) VALUES ($1) RETURNING id", [`${TAG} ${name}`]);
  ids.locations.push(row!.id);
  return row!.id;
}
async function makeHolder(name: string, kind = "crew"): Promise<string> {
  const [row] = await q<{ id: string }>("INSERT INTO entities (name, kind) VALUES ($1, $2) RETURNING id", [
    `${TAG} ${name}`,
    kind,
  ]);
  ids.entities.push(row!.id);
  return row!.id;
}
async function level(itemId: string, locationId: string): Promise<number> {
  const [row] = await q<{ qty: string }>("SELECT qty FROM stock_levels WHERE item_id = $1 AND location_id = $2", [
    itemId,
    locationId,
  ]);
  return ledger.toQty(row?.qty);
}

describe("consumables against Postgres", { skip }, () => {
  let warehouse: string;
  let annex: string;
  let crew: string;
  let truck: string;
  let tape: string;
  let boxes: string;

  before(async () => {
    const { runMigrations } = await import("../src/db/migrate");
    dbmod = await import("../src/db/client");
    await runMigrations();
    stock = await import("../src/services/consumables/stock");
    kits = await import("../src/services/consumables/kits");
    low = await import("../src/services/consumables/lowstock");
    ledger = await import("../src/services/consumables/ledger");

    warehouse = await makeLocation("Warehouse");
    annex = await makeLocation("Annex");
    crew = await makeHolder("Crew 1", "crew");
    truck = await makeHolder("Truck 7", "vehicle");
    tape = await makeItem("Packing tape", 250);
    boxes = await makeItem("Medium boxes", 180);
    await stock.setConsumable(tape, { unit: "roll", reorderPoint: 10, reorderQty: 24, supplier: "Uline" });
    await stock.setConsumable(boxes, { unit: "each", reorderPoint: 5 });
  });

  after(async () => {
    if (!dbmod) return;
    // Deleting the items cascades their levels, movements, kits' lines and assignments.
    await q("DELETE FROM equipment_kits WHERE holder_entity_id = ANY($1::uuid[])", [ids.entities]);
    await q("DELETE FROM items WHERE id = ANY($1::uuid[])", [ids.items]);
    await q("DELETE FROM locations WHERE id = ANY($1::uuid[])", [ids.locations]);
    await q("DELETE FROM entities WHERE id = ANY($1::uuid[])", [ids.entities]);
    await q("DELETE FROM consumable_digest_runs WHERE day >= '2099-01-01'");
    await dbmod.pool.end();
  });

  it("keeps stock levels equal to the sum of movements through every kind of movement", async () => {
    const move = (r: Parameters<Stock["recordMovement"]>[0], actor = MEMBER) => stock.recordMovement(r, actor);
    await move({ reason: "receive", itemId: tape, qty: 50, locationId: warehouse });
    await move({ reason: "receive", itemId: boxes, qty: 100, locationId: warehouse, note: "PO 1234" });
    await move({ reason: "transfer", itemId: tape, qty: 10, locationId: warehouse, toLocationId: annex });
    await move({ reason: "issue", itemId: tape, qty: 20, locationId: warehouse, holderId: crew, jobRef: "JOB-9" });
    await move({ reason: "issue", itemId: boxes, qty: 40, locationId: warehouse, holderId: truck });
    await move({ reason: "return", itemId: tape, qty: 5, locationId: warehouse, holderId: crew });
    await move({ reason: "consume", itemId: tape, qty: 3, holderId: crew });
    await move({ reason: "consume", itemId: tape, qty: 2, locationId: annex, holderId: crew });
    await move({ reason: "return", itemId: boxes, qty: 12.5, locationId: annex, holderId: truck });
    const count = await stock.recordCount(
      warehouse,
      [
        { itemId: tape, countedQty: 23 }, // 50 - 10 - 20 + 5 = 25 on file
        { itemId: boxes, countedQty: 60 }, // 100 - 40 = 60 on file
      ],
      MEMBER,
    );
    await move({ reason: "adjust", itemId: tape, delta: 1, locationId: annex, note: "Found behind the rack" }, ADMIN);

    assert.deepEqual(
      count.lines.map((l) => [l.itemId, l.expectedQty, l.countedQty, l.variance]).sort(),
      [
        [tape, 25, 23, -2],
        [boxes, 60, 60, 0],
      ].sort(),
    );
    assert.equal(await level(tape, warehouse), 23);
    assert.equal(await level(tape, annex), 10 - 2 + 1);
    assert.equal(await level(boxes, warehouse), 60);
    assert.equal(await level(boxes, annex), 12.5);

    // The property itself: every stored level agrees with its movements.
    assert.deepEqual(await stock.checkIntegrity([tape, boxes]), []);

    // And rebuilding from the stored movements alone gives the same answer.
    const rows = await q<{
      item_id: string;
      qty: string;
      from_location_id: string | null;
      to_location_id: string | null;
      holder_entity_id: string | null;
      holder_delta: string;
    }>("SELECT * FROM stock_movements WHERE item_id = ANY($1::uuid[]) ORDER BY created_at", [[tape, boxes]]);
    const rebuilt = ledger.replay(
      rows.map((r) => ({
        itemId: r.item_id,
        qty: ledger.toQty(r.qty),
        fromLocationId: r.from_location_id,
        toLocationId: r.to_location_id,
        holderId: r.holder_entity_id,
        holderDelta: ledger.toQty(r.holder_delta),
      })),
    );
    for (const [item, loc] of [
      [tape, warehouse],
      [tape, annex],
      [boxes, warehouse],
      [boxes, annex],
    ] as const) {
      assert.equal(rebuilt.levels.get(`${item}|${loc}`) ?? 0, await level(item, loc));
    }
    // Crew 1 was issued 20 tape, returned 5 and used 3 of what they had.
    assert.equal(rebuilt.holders.get(`${tape}|${crew}`), 12);
    const balances = await stock.holderBalances({ holderId: crew });
    assert.deepEqual(
      balances.map((b) => [b.itemId, b.balance]),
      [[tape, 12]],
    );

    // Unit cost is captured on the movement.
    const [issue] = await q<{ unit_cost_cents: string }>(
      "SELECT unit_cost_cents FROM stock_movements WHERE item_id = $1 AND reason = 'issue'",
      [tape],
    );
    assert.equal(Number(issue!.unit_cost_cents), 250);
  });

  it("refuses to go negative, and a refused movement changes nothing", async () => {
    const before = await level(tape, warehouse);
    await assert.rejects(
      stock.recordMovement({ reason: "issue", itemId: tape, qty: before + 1, locationId: warehouse, holderId: crew }, MEMBER),
      /Only 23 roll of .* on hand/,
    );
    await assert.rejects(
      stock.recordMovement({ reason: "return", itemId: tape, qty: 13, locationId: warehouse, holderId: crew }, MEMBER),
      /has 12 roll of .* outstanding, not 13/,
    );
    await assert.rejects(
      stock.recordMovement({ reason: "consume", itemId: tape, qty: 13, holderId: crew }, MEMBER),
      /outstanding/,
    );
    await assert.rejects(
      stock.recordMovement({ reason: "transfer", itemId: tape, qty: 100, locationId: annex, toLocationId: warehouse }, MEMBER),
      /on hand/,
    );
    assert.equal(await level(tape, warehouse), before);
    assert.deepEqual(await stock.checkIntegrity([tape, boxes]), []);
  });

  it("lets only an administrator adjust, only with a reason, and only they can go below zero", async () => {
    await assert.rejects(
      stock.recordMovement({ reason: "adjust", itemId: boxes, delta: -5, locationId: annex, note: "x" }, MEMBER),
      (err: Error & { status?: number }) => err.status === 403,
    );
    await assert.rejects(
      stock.recordMovement({ reason: "adjust", itemId: boxes, delta: -5, locationId: annex }, ADMIN),
      /Say why/,
    );
    await stock.recordMovement(
      { reason: "adjust", itemId: boxes, delta: -15, locationId: annex, note: "Used before the delivery was booked in" },
      ADMIN,
    );
    assert.equal(await level(boxes, annex), -2.5);
    assert.deepEqual(await stock.checkIntegrity([tape, boxes]), []);
    // Put it back so later tests start from a clean shelf.
    await stock.recordCount(annex, [{ itemId: boxes, countedQty: 0 }], MEMBER);
    assert.equal(await level(boxes, annex), 0);
  });

  it("never oversells under concurrent issues", async () => {
    const wrap = await makeItem("Stretch wrap", 1999);
    await stock.setConsumable(wrap, { unit: "roll" });
    await stock.recordMovement({ reason: "receive", itemId: wrap, qty: 30, locationId: warehouse }, MEMBER);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        stock.recordMovement({ reason: "issue", itemId: wrap, qty: 5, locationId: warehouse, holderId: crew }, MEMBER),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 6);
    assert.equal(await level(wrap, warehouse), 0);
    assert.deepEqual(await stock.checkIntegrity([wrap]), []);
  });

  it("refuses stock movements for an item that is not a consumable", async () => {
    const dolly = await makeItem("Dolly");
    await assert.rejects(
      stock.recordMovement({ reason: "receive", itemId: dolly, qty: 1, locationId: warehouse }, MEMBER),
      /not tracked as a consumable/,
    );
  });

  it("checks out a kit of 12 and, after a partial return, shows exactly the missing pieces", async () => {
    const pieces: string[] = [];
    for (let i = 1; i <= 12; i++) pieces.push(await makeItem(`Moving blanket ${i}`));
    const { kit, failures } = await kits.createKit(
      {
        holderId: truck,
        expectedReturnAt: new Date(Date.now() - 60_000),
        jobRef: "JOB-42",
        lines: [...pieces.map((itemId) => ({ itemId })), { itemId: tape }],
      },
      MEMBER,
    );
    // The consumable is refused, every piece of equipment goes out.
    assert.equal(kit.total, 12);
    assert.equal(kit.outCount, 12);
    assert.deepEqual(failures.map((f) => f.itemId), [tape]);
    const [open] = await q<{ n: string }>(
      "SELECT count(*) AS n FROM item_assignments WHERE item_id = ANY($1::uuid[]) AND checked_in_at IS NULL AND entity_id = $2",
      [pieces, truck],
    );
    assert.equal(Number(open!.n), 12);

    const back = pieces.slice(0, 9);
    const missing = pieces.slice(9);
    const result = await kits.returnEquipment({ holderId: truck, lines: back.map((itemId) => ({ itemId })) }, MEMBER);
    assert.equal(result.returned.length, 9);
    assert.equal(result.notOut.length, 0);
    assert.deepEqual(result.stillOut.map((r) => r.itemId).sort(), [...missing].sort());

    const after = await kits.getKit(kit.id);
    assert.deepEqual(after.missing.map((l) => l.itemId).sort(), [...missing].sort());
    assert.equal(after.returnedCount, 9);
    assert.equal(after.closedAt, null);
    assert.equal(after.overdue, true);

    const sheet = await kits.holderEquipment(truck, new Date(Date.now() - 3_600_000));
    assert.equal(sheet.wentOut.length, 12);
    assert.equal(sheet.cameBack.length, 9);
    assert.deepEqual(sheet.stillOut.map((r) => r.itemId).sort(), [...missing].sort());
    assert.ok(sheet.stillOut.every((r) => r.overdue));

    const overdue = (await kits.listOverdue()).filter((o) => o.kitId === kit.id);
    assert.deepEqual(overdue.map((o) => o.itemId).sort(), [...missing].sort());

    // A second scan of something already back is reported, not re-returned.
    const again = await kits.returnEquipment({ holderId: truck, lines: [{ itemId: back[0]! }] }, MEMBER);
    assert.equal(again.returned.length, 0);
    assert.equal(again.notOut.length, 1);

    // Returning the rest closes the kit.
    await kits.returnEquipment({ holderId: truck, lines: missing.map((itemId) => ({ itemId })) }, MEMBER);
    const closed = await kits.getKit(kit.id);
    assert.equal(closed.missing.length, 0);
    assert.notEqual(closed.closedAt, null);
  });

  it("takes back a piece that was out to someone else, and flags it", async () => {
    const strap = await makeItem("Ratchet strap");
    await kits.createKit({ holderId: crew, lines: [{ itemId: strap }] }, MEMBER);
    const r = await kits.returnEquipment({ holderId: truck, lines: [{ itemId: strap }] }, MEMBER);
    assert.equal(r.returned.length, 1);
    assert.equal(r.returned[0]!.wrongHolder, true);
    assert.equal(r.returned[0]!.fromHolderId, crew);
  });

  it("sends the low-stock digest once a day, not once per check", async () => {
    // Tape is at 10 in the annex against a reorder point of 10.
    const lowRows = await low.listLowStock();
    assert.ok(lowRows.some((r) => r.itemId === tape && r.locationId === annex));

    const sent: string[] = [];
    const deps = {
      hour: 7,
      configured: true,
      enabled: true,
      send: async (n: { title: string; message: string }) => {
        sent.push(n.title);
        return true;
      },
    };
    const morning = new Date(2099, 0, 1, 6, 30);
    assert.equal((await low.runLowStockDigest({ ...deps, now: morning })).outcome, "not_yet");
    const first = await low.runLowStockDigest({ ...deps, now: new Date(2099, 0, 1, 7, 5) });
    assert.equal(first.outcome, "sent");
    for (let h = 8; h < 24; h++) {
      assert.equal((await low.runLowStockDigest({ ...deps, now: new Date(2099, 0, 1, h, 5) })).outcome, "already_sent");
    }
    assert.equal(sent.length, 1);
    assert.equal((await low.runLowStockDigest({ ...deps, now: new Date(2099, 0, 2, 7, 5) })).outcome, "sent");
    assert.equal(sent.length, 2);

    // A failed delivery gives the day back, so the next hourly check retries.
    let fail = true;
    const flaky = { ...deps, send: async () => !fail };
    assert.equal((await low.runLowStockDigest({ ...flaky, now: new Date(2099, 0, 3, 7, 5) })).outcome, "failed");
    fail = false;
    assert.equal((await low.runLowStockDigest({ ...flaky, now: new Date(2099, 0, 3, 8, 5) })).outcome, "sent");

    // Quietly does nothing when there is nowhere to send it or the feature is off.
    assert.equal((await low.runLowStockDigest({ ...deps, configured: false, now: new Date(2099, 0, 4, 9) })).outcome, "not_configured");
    assert.equal((await low.runLowStockDigest({ ...deps, enabled: false, now: new Date(2099, 0, 4, 9) })).outcome, "feature_off");
    const [runs] = await q<{ n: string }>("SELECT count(*) AS n FROM consumable_digest_runs WHERE day >= '2099-01-01'");
    assert.equal(Number(runs!.n), 3);
  });
});
