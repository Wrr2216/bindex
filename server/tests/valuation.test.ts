import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  RECEIPT_ELECTRONICS,
  RECEIPT_EUROPEAN,
  RECEIPT_MISREAD,
  RECEIPT_NONE,
  VALUATION_GOOD,
  VALUATION_VAGUE,
} from "./valuation-fixtures";

// Pure logic of the valuation feature: parsing what models send, matching
// receipt lines to items, and the warranty, service and depreciation maths.

type Parse = typeof import("../src/services/valuation/parse");
type Estimate = typeof import("../src/services/valuation/estimate");
type Receipt = typeof import("../src/services/valuation/receiptParse");
type Matching = typeof import("../src/services/valuation/matching");
type Schedule = typeof import("../src/services/valuation/schedule");
type Settings = typeof import("../src/services/valuation/settings");
type Digest = typeof import("../src/services/valuation/digest");
type Declarations = typeof import("../src/services/valuation/declarations");
let p: Parse;
let est: Estimate;
let rc: Receipt;
let m: Matching;
let s: Schedule;
let settings: Settings;
let digest: Digest;
let decl: Declarations;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  p = await import("../src/services/valuation/parse");
  est = await import("../src/services/valuation/estimate");
  rc = await import("../src/services/valuation/receiptParse");
  m = await import("../src/services/valuation/matching");
  s = await import("../src/services/valuation/schedule");
  settings = await import("../src/services/valuation/settings");
  digest = await import("../src/services/valuation/digest");
  decl = await import("../src/services/valuation/declarations");
});

const NOW = new Date("2026-09-26T12:00:00Z");

describe("parseMoney", () => {
  it("reads numbers and printed amounts as cents", () => {
    assert.equal(p.parseMoney(1299.99), 129999);
    assert.equal(p.parseMoney("$1,299.99"), 129999);
    assert.equal(p.parseMoney("1.299,99 €"), 129999);
    assert.equal(p.parseMoney("12,50"), 1250);
    assert.equal(p.parseMoney("1,200"), 120000);
    assert.equal(p.parseMoney("1.200.000"), 120000000);
    assert.equal(p.parseMoney("USD 45"), 4500);
    assert.equal(p.parseMoney("CHF 1'234.50"), 123450);
    assert.equal(p.parseMoney(0.1 + 0.2), 30);
  });

  it("keeps negatives only where they are allowed", () => {
    assert.equal(p.parseMoney("-20,00"), null);
    assert.equal(p.parseMoney("-20,00", { allowNegative: true }), -2000);
    assert.equal(p.parseMoney("(4.00)", { allowNegative: true }), -400);
    assert.equal(p.parseMoney("4.00-", { allowNegative: true }), -400);
  });

  it("refuses what is not an amount", () => {
    for (const v of ["", "free", "12 apples", null, undefined, Number.NaN, Infinity, {}, "1e20", 5e11]) {
      assert.equal(p.parseMoney(v), null, String(v));
    }
  });
});

describe("parseDate", () => {
  it("reads ISO and month-name dates in any locale", () => {
    assert.equal(p.parseDate("2024-03-02", "en-GB", NOW), "2024-03-02");
    assert.equal(p.parseDate("2024-03-02T14:31:00", "en-US", NOW), "2024-03-02");
    assert.equal(p.parseDate("Mar 2, 2024", "de-DE", NOW), "2024-03-02");
    assert.equal(p.parseDate("2 March 2024", "en-US", NOW), "2024-03-02");
    assert.equal(p.parseDate("02-MAR-24", "en-US", NOW), "2024-03-02");
    assert.equal(p.parseDate("Date: 2024.03.02", "en-US", NOW), "2024-03-02");
  });

  it("reads an ambiguous numeric date by the locale, unless a number settles it", () => {
    assert.equal(p.parseDate("03/02/2024", "en-US", NOW), "2024-03-02");
    assert.equal(p.parseDate("03/02/2024", "en-GB", NOW), "2024-02-03");
    assert.equal(p.parseDate("03.02.2024", "de-DE", NOW), "2024-02-03");
    assert.equal(p.parseDate("31/01/2024", "en-US", NOW), "2024-01-31");
    assert.equal(p.parseDate("01/31/2024", "en-GB", NOW), "2024-01-31");
    assert.equal(p.parseDate("03/02/24 2:31 PM", "en-US", NOW), "2024-03-02");
  });

  it("refuses impossible and future dates", () => {
    assert.equal(p.parseDate("2023-02-29", "en-US", NOW), null);
    assert.equal(p.parseDate("32/13/2024", "en-US", NOW), null);
    assert.equal(p.parseDate("2031-01-01", "en-US", NOW), null);
    assert.equal(p.parseDate("1901-01-01", "en-US", NOW), null);
    assert.equal(p.parseDate("soon", "en-US", NOW), null);
  });

  it("adds months without running past the end of a month", () => {
    assert.equal(p.addMonths("2024-01-31", 1), "2024-02-29");
    assert.equal(p.addMonths("2023-01-31", 1), "2023-02-28");
    assert.equal(p.addMonths("2024-03-02", 24), "2026-03-02");
    assert.equal(p.addMonths("2024-11-15", 3), "2025-02-15");
  });
});

describe("normalizeEstimate", () => {
  it("cleans a good reply and suggests the middle of the range", () => {
    const e = est.normalizeEstimate(VALUATION_GOOD, "USD")!;
    assert.equal(e.brand, "Herman Miller");
    assert.equal(e.materials, "aluminium, pellicle mesh");
    assert.equal(e.condition, "good");
    assert.deepEqual(e.estimatedValue, {
      lowCents: 55000,
      highCents: 75000,
      suggestedCents: 65000,
      currency: "USD",
      basis: "Used resale price for a size B Aeron in good condition.",
    });
    assert.equal(e.confidence, 0.82);
    assert.equal(e.currencyMismatch, false);
  });

  it("caps confidence for an unidentified item and a range too wide to sign", () => {
    const e = est.normalizeEstimate(VALUATION_VAGUE, "USD")!;
    assert.equal(e.brand, null);
    assert.equal(e.estimatedValue?.lowCents, 2000);
    assert.equal(e.estimatedValue?.highCents, 40000);
    assert.equal(e.confidence, 0.3);
  });

  it("takes other shapes: one number, a swapped range, another currency", () => {
    assert.equal(est.normalizeEstimate({ brand: "Makita", value: 120 }, "USD")?.estimatedValue?.suggestedCents, 12000);
    const swapped = est.normalizeEstimate({ model: "X1", estimatedValue: { low: 900, high: 700 } }, "USD")!;
    assert.deepEqual([swapped.estimatedValue?.lowCents, swapped.estimatedValue?.highCents], [70000, 90000]);
    const eur = est.normalizeEstimate({ brand: "Bosch", estimatedValue: { low: 100, high: 120, currency: "EUR" } }, "USD")!;
    assert.equal(eur.currencyMismatch, true);
    assert.equal(eur.estimatedValue?.currency, "EUR");
    const words = est.normalizeEstimate({ brand: "Bosch", estimatedValue: { min: "1,000", max: "1,500" }, confidence: "85%" }, "USD")!;
    assert.equal(words.estimatedValue?.highCents, 150000);
    assert.equal(words.confidence, 0.85);
  });

  it("returns null for nothing usable", () => {
    assert.equal(est.normalizeEstimate(null, "USD"), null);
    assert.equal(est.normalizeEstimate({}, "USD"), null);
    assert.equal(est.normalizeEstimate({ brand: "n/a", estimatedValue: "unknown" }, "USD"), null);
    assert.equal(est.normalizeEstimate([] as unknown as Record<string, unknown>, "USD"), null);
  });

  it("puts the instance currency and what is on file into the prompt", () => {
    const prompt = est.valuationPrompt("EUR", { name: "Chair", brand: "Vitra" });
    assert.match(prompt, /in EUR/);
    assert.match(prompt, /brand "Vitra"/);
  });
});

describe("normalizeReceipt", () => {
  it("reads a clean receipt: lines, serials, warranty months, totals", () => {
    const r = rc.normalizeReceipt(RECEIPT_ELECTRONICS, { locale: "en-US", currency: "USD", now: NOW })!;
    assert.equal(r.vendor, "Micro Center #041");
    assert.equal(r.purchaseDate, "2024-03-02");
    assert.equal(r.datePrinted, "03/02/2024");
    assert.equal(r.lines.length, 4);
    assert.deepEqual(r.lines[0], {
      description: "DELL LAT 5440 I7 16GB 512GB",
      quantity: 1,
      unitPriceCents: 129999,
      totalCents: 129999,
      sku: "LAT5440-7XK",
      serial: "7XK2P93",
      warrantyMonths: null,
    });
    assert.equal(r.lines[1]!.totalCents, 65800);
    assert.equal(r.lines[3]!.warrantyMonths, 24);
    assert.equal(r.subtotalCents, 211998);
    assert.equal(r.taxCents, 17490);
    assert.equal(r.totalCents, 229488);
    assert.deepEqual(r.warnings, []);
  });

  it("reads a European receipt with other key names, decimal commas and a discount", () => {
    const r = rc.normalizeReceipt(RECEIPT_EUROPEAN, { locale: "de-DE", currency: "EUR", now: NOW })!;
    assert.equal(r.vendor, "Bürohaus Müller GmbH");
    assert.equal(r.purchaseDate, "2024-02-03");
    assert.equal(r.currency, "EUR");
    assert.equal(r.lines[0]!.quantity, 2);
    assert.equal(r.lines[0]!.unitPriceCents, 18950);
    assert.equal(r.lines[0]!.totalCents, 37900);
    assert.equal(r.lines[1]!.totalCents, -2000);
    assert.equal(r.totalCents, 42721);
    assert.deepEqual(r.warnings, []);
  });

  it("warns when the arithmetic or the date does not work out", () => {
    const r = rc.normalizeReceipt(RECEIPT_MISREAD, { locale: "en-US", currency: "USD", now: NOW })!;
    assert.equal(r.purchaseDate, null);
    assert.equal(r.warnings.length, 4);
    assert.match(r.warnings[0]!, /could not be read as a date/);
    assert.match(r.warnings[1]!, /Line 2: 2 × 25.00 is not 60.00/);
    assert.match(r.warnings[2]!, /add up to 509.00 but the receipt says 600.00 before tax/);
    assert.match(r.warnings[3]!, /Subtotal 600.00 plus tax 30.00 is not the total 700.00/);
  });

  it("fills a missing unit price or total from the other", () => {
    const r = rc.normalizeReceipt({ vendor: "X", lines: [{ description: "A", qty: 4, total: 10 }, { description: "B", qty: 3, unitPrice: 2.5 }] }, { currency: "USD" })!;
    assert.equal(r.lines[0]!.unitPriceCents, 250);
    assert.equal(r.lines[1]!.totalCents, 750);
  });

  it("returns null when there is no receipt, and drops lines without a description", () => {
    assert.equal(rc.normalizeReceipt(RECEIPT_NONE, { currency: "USD" }), null);
    assert.equal(rc.normalizeReceipt(null, { currency: "USD" }), null);
    assert.equal(rc.normalizeReceipt({ lines: "none" }, { currency: "USD" }), null);
    const r = rc.normalizeReceipt({ vendor: "Shop", lines: [{ qty: 1, total: 5 }, "junk", null, { description: "Tape", total: 3 }] }, { currency: "USD" })!;
    assert.deepEqual(r.lines.map((l) => l.description), ["Tape"]);
  });
});

describe("receipt matching", () => {
  const laptop = { itemId: "i-laptop", name: "Laptop", brand: "Dell", model: "Latitude 5440", assetCode: "INV-1", serials: ["7XK2P93"], codes: [], units: [] };
  const other = { itemId: "i-other", name: "Laptop", brand: "Dell", model: "Latitude 7440", assetCode: "INV-2", serials: ["9ZZ1111"], codes: [], units: [] };
  const monitors = {
    itemId: "i-mon",
    name: "27 inch monitor",
    brand: "Dell",
    model: "P2723DE",
    assetCode: "INV-3",
    serials: [],
    codes: ["884116400001"],
    units: [
      { id: "u-1", serial: "CN0ABC123", label: "Desk 1" },
      { id: "u-2", serial: "CN0ABC124", label: "Desk 2" },
    ],
  };
  const chair = { itemId: "i-chair", name: "Aeron office chair", brand: "Herman Miller", model: null, assetCode: "INV-4", serials: [], codes: ["AER1B23DW"], units: [] };
  const jack = { itemId: "i-jack", name: "Pallet jack", brand: null, model: null, assetCode: "INV-5", serials: [], codes: [], units: [] };
  const candidates = [laptop, other, monitors, chair, jack];

  it("scores a serial above everything else, and names the unit it is on", () => {
    const bySerial = m.scoreMatch({ description: "Some laptop", sku: null, serial: "7xk-2p93" }, laptop)!;
    assert.equal(bySerial.score, 1);
    assert.equal(bySerial.reason, "serial");
    const byUnit = m.scoreMatch({ description: "Monitor", sku: null, serial: "CN0ABC124" }, monitors)!;
    assert.deepEqual([byUnit.unitId, byUnit.reason], ["u-2", "unit_serial"]);
    const inText = m.scoreMatch({ description: "MONITOR SN CN0ABC123", sku: null, serial: null }, monitors)!;
    assert.deepEqual([inText.unitId, inText.score], ["u-1", 0.95]);
  });

  it("uses product codes and model numbers, then names", () => {
    assert.equal(m.scoreMatch({ description: "HM chair", sku: "AER1B23DW", serial: null }, chair)!.reason, "code");
    assert.equal(m.scoreMatch({ description: "Monitor", sku: "P2723DE", serial: null }, monitors)!.reason, "model");
    assert.equal(m.scoreMatch({ description: "DELL LAT 5440 I7", sku: null, serial: null }, laptop)!.reason, "name");
    const byModel = m.scoreMatch({ description: "DELL LATITUDE 5440 16GB", sku: null, serial: null }, laptop)!;
    assert.deepEqual([byModel.reason, byModel.score], ["model", 0.8]);
    assert.equal(m.scoreMatch({ description: "USB-C CABLE 2M", sku: null, serial: null }, laptop), null);
  });

  it("proposes one record per line, best evidence first, never the same record twice", () => {
    const r = rc.normalizeReceipt(RECEIPT_ELECTRONICS, { locale: "en-US", currency: "USD", now: NOW })!;
    const proposals = m.proposeMatches(r.lines, candidates);
    assert.equal(proposals.length, 4);
    assert.equal(proposals[0]!.suggested?.itemId, "i-laptop");
    assert.equal(proposals[0]!.suggested?.reason, "serial");
    // The other Latitude is offered but not picked.
    assert.ok(proposals[0]!.candidates.some((c) => c.itemId === "i-other"));
    assert.equal(proposals[1]!.suggested?.itemId, "i-mon");
    assert.equal(proposals[2]!.suggested, null);
    // The protection plan names the laptop but the laptop is already taken by line 1.
    assert.notEqual(proposals[3]!.suggested?.itemId, "i-laptop");
  });

  it("does not give one record to two lines, and prefers the item the receipt was started from", () => {
    const lines = [
      { description: "PALLET JACK 5500LB", sku: null, serial: null },
      { description: "PALLET JACK WHEELS", sku: null, serial: null },
    ];
    const proposals = m.proposeMatches(lines, candidates);
    assert.equal(proposals[0]!.suggested?.itemId, "i-jack");
    assert.equal(proposals[1]!.suggested, null);
    assert.ok(proposals[1]!.candidates.some((c) => c.itemId === "i-jack"));

    const tie = m.proposeMatches([{ description: "Dell Laptop", sku: null, serial: null }], [laptop, other], "i-other");
    assert.equal(tie[0]!.suggested?.itemId, "i-other");
  });

  it("rates abbreviations as similar names", () => {
    assert.ok(m.nameSimilarity("HM AERON CHAIR SZ B", "Herman Miller Aeron office chair") >= 0.6);
    assert.ok(m.nameSimilarity("PALLET JACK", "Printer toner") < 0.2);
    assert.equal(m.nameSimilarity("", "Anything"), 0);
  });
});

describe("service status", () => {
  const plan = (over: Partial<import("../src/services/valuation/schedule").ServicePlanLike> = {}) => ({
    intervalDays: 90,
    intervalHours: null,
    startsAt: new Date("2026-07-01T00:00:00Z"),
    startsHours: null,
    lastDoneAt: null,
    lastDoneHours: null,
    active: true,
    ...over,
  });
  const opts = { now: NOW, soonDays: 14, soonPercent: 10 };

  it("counts days from the start, then from the last service", () => {
    const fresh = s.serviceStatus(plan(), null, opts);
    assert.equal(fresh.dueAt?.toISOString().slice(0, 10), "2026-09-29");
    assert.deepEqual([fresh.state, fresh.reason, fresh.daysLeft], ["soon", "days", 2]);
    const done = s.serviceStatus(plan({ lastDoneAt: new Date("2026-09-01T00:00:00Z") }), null, opts);
    assert.equal(done.state, "ok");
    const late = s.serviceStatus(plan({ startsAt: new Date("2026-01-01T00:00:00Z") }), null, opts);
    assert.equal(late.state, "overdue");
    assert.ok(late.daysLeft! < 0);
  });

  it("counts hours of use against the meter, and takes whichever limit comes first", () => {
    const hours = plan({ intervalDays: null, intervalHours: 250, lastDoneHours: 1000 });
    assert.equal(s.serviceStatus(hours, 1100, opts).state, "ok");
    assert.equal(s.serviceStatus(hours, 1230, opts).state, "soon");
    const over = s.serviceStatus(hours, 1260, opts);
    assert.deepEqual([over.state, over.reason, over.hoursLeft, over.dueHours], ["overdue", "hours", -10, 1250]);
    // No meter reading yet: nothing to compare against.
    assert.equal(s.serviceStatus(hours, null, opts).state, "ok");
    const both = plan({ intervalDays: 365, intervalHours: 250, lastDoneAt: new Date("2026-09-01T00:00:00Z"), lastDoneHours: 1000 });
    assert.deepEqual([s.serviceStatus(both, 1300, opts).state, s.serviceStatus(both, 1300, opts).reason], ["overdue", "hours"]);
  });

  it("gives each due point its own key, and leaves inactive plans alone", () => {
    const a = s.serviceStatus(plan(), null, opts);
    const b = s.serviceStatus(plan({ lastDoneAt: new Date("2026-09-20T00:00:00Z") }), null, opts);
    assert.notEqual(a.dueKey, b.dueKey);
    assert.equal(s.serviceStatus(plan({ active: false, startsAt: new Date("2020-01-01") }), null, opts).state, "inactive");
  });
});

describe("warranty, depreciation and high value", () => {
  it("places a warranty end against the reminder window", () => {
    assert.deepEqual(s.warrantyState("2026-10-10", "2026-09-26", 30), { state: "expiring", daysLeft: 14 });
    assert.deepEqual(s.warrantyState("2027-10-10", "2026-09-26", 30), { state: "active", daysLeft: 379 });
    assert.equal(s.warrantyState("2026-09-25", "2026-09-26", 30).state, "expired");
    assert.equal(s.warrantyState(null, "2026-09-26", 30).state, "none");
    assert.equal(s.warrantyEndFrom("2024-03-02", 24), "2026-03-02");
  });

  it("depreciates on a straight line to salvage, and not before purchase", () => {
    const d = s.straightLine(120000, "2024-09-26", "2026-09-26", 4, 0)!;
    assert.equal(d.ageYears, 2);
    // 730 days is a whisker under two years of 365.25 days.
    assert.ok(Math.abs(d.bookCents - 60000) < 100, String(d.bookCents));
    assert.equal(d.depreciatedCents + d.bookCents, 120000);
    const salvage = s.straightLine(100000, "2016-01-01", "2026-09-26", 5, 10)!;
    assert.deepEqual([salvage.bookCents, salvage.fullyDepreciated], [10000, true]);
    assert.equal(s.straightLine(100000, "2027-01-01", "2026-09-26", 5, 0)!.bookCents, 100000);
    assert.equal(s.straightLine(null, "2024-01-01", "2026-09-26", 5, 0), null);
    assert.equal(s.straightLine(100000, null, "2026-09-26", 5, 0), null);
  });

  it("looks up a category's life without regard to case, else the default", () => {
    const dep = { defaultLifeYears: 5, salvagePercent: 0, lifeYearsByCategory: { Laptop: 3, " Furniture ": 10 } };
    assert.equal(s.lifeFor("laptop", dep), 3);
    assert.equal(s.lifeFor("FURNITURE", dep), 10);
    assert.equal(s.lifeFor("Vehicle", dep), 5);
    assert.equal(s.lifeFor(null, dep), 5);
  });

  it("marks high value by threshold unless overridden", () => {
    assert.equal(s.isHighValue("auto", 250000, 250000), true);
    assert.equal(s.isHighValue("auto", 249999, 250000), false);
    assert.equal(s.isHighValue("auto", null, 250000), false);
    assert.equal(s.isHighValue("auto", 900000, 0), false);
    assert.equal(s.isHighValue("yes", 100, 250000), true);
    assert.equal(s.isHighValue("no", 900000, 250000), false);
  });
});

describe("settings", () => {
  it("merges stored values over the defaults, dropping the invalid ones", () => {
    const merged = settings.mergeSettings({
      highValueThresholdCents: 500000,
      warrantyAlertDays: -5,
      notify: "yes",
      depreciation: { defaultLifeYears: 7, lifeYearsByCategory: { Laptop: 3, Bad: -1, "": 4 } },
    });
    assert.equal(merged.highValueThresholdCents, 500000);
    assert.equal(merged.warrantyAlertDays, 30);
    assert.equal(merged.notify, true);
    assert.deepEqual(merged.depreciation, { defaultLifeYears: 7, salvagePercent: 0, lifeYearsByCategory: { Laptop: 3 } });
    assert.deepEqual(settings.mergeSettings("garbage"), settings.DEFAULT_SETTINGS);
  });
});

describe("digest selection", () => {
  it("lists warranties in the window and plans falling due, marking what is not yet announced", () => {
    const base = settings.DEFAULT_SETTINGS;
    const due = digest.selectDue(
      [
        { itemId: "a", unitId: null, name: "Forklift", warrantyEnds: "2026-10-06", warrantyProvider: "Toyota", warrantyAlertedFor: null },
        { itemId: "b", unitId: null, name: "Laptop", warrantyEnds: "2026-10-01", warrantyProvider: null, warrantyAlertedFor: "2026-10-01" },
        { itemId: "c", unitId: null, name: "Printer", warrantyEnds: "2027-01-01", warrantyProvider: null, warrantyAlertedFor: null },
        { itemId: "d", unitId: null, name: "Old", warrantyEnds: "2026-09-01", warrantyProvider: null, warrantyAlertedFor: null },
      ],
      [
        {
          id: "p1", itemId: "a", unitId: null, name: "Forklift", planName: "Service", intervalDays: 30, intervalHours: null,
          startsAt: new Date("2026-08-01T00:00:00Z"), startsHours: null, lastDoneAt: null, lastDoneHours: null, active: true,
          alertedFor: null, usageHours: null,
        },
        {
          id: "p2", itemId: "a", unitId: null, name: "Forklift", planName: "Hydraulics", intervalDays: null, intervalHours: 500,
          startsAt: new Date("2026-01-01T00:00:00Z"), startsHours: 0, lastDoneAt: null, lastDoneHours: 1000, active: true,
          alertedFor: "|1500", usageHours: 1480,
        },
        {
          id: "p3", itemId: "b", unitId: null, name: "Laptop", planName: "Clean", intervalDays: 365, intervalHours: null,
          startsAt: new Date("2026-09-01T00:00:00Z"), startsHours: null, lastDoneAt: null, lastDoneHours: null, active: true,
          alertedFor: null, usageHours: null,
        },
      ],
      base,
      NOW,
    );
    assert.deepEqual(due.warranty.map((w) => [w.name, w.daysLeft, w.isNew]), [["Laptop", 5, false], ["Forklift", 10, true]]);
    assert.deepEqual(due.service.map((x) => [x.planName, x.status.state, x.isNew]), [["Service", "overdue", true], ["Hydraulics", "soon", false]]);
  });
});

describe("declaration content", () => {
  it("is the same whatever order the lines come in, and changes with any declared fact", () => {
    const row = {
      id: "d1", code: "HVI-00001", title: "Office", scope: "location" as const, scopeId: null, scopeLabel: "HQ", status: "draft" as const,
      currency: "USD", notes: null, signatureId: null, signedAt: null, auditEntryId: null, createdBy: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const line = (position: number, declaredCents: number) => ({
      id: `l${position}`, declarationId: "d1", position, itemId: null, unitId: null, valuationId: null, name: `Item ${position}`,
      brand: null, model: null, serial: null, assetCode: null, description: null, materials: null, condition: null,
      declaredCents, valueSource: "manual", notes: null,
    });
    const a = decl.declarationContent(row, [line(1, 10000), line(2, 25000)]);
    const b = decl.declarationContent(row, [line(2, 25000), line(1, 10000)]);
    assert.deepEqual(a, b);
    assert.equal(a.totalCents, 35000);
    assert.notDeepEqual(a, decl.declarationContent(row, [line(1, 10000), line(2, 25001)]));
    const statement = decl.declarationStatement({ ...a, lines: [{ ...a.lines[0]!, valueSource: "ai" }] }, "en-US");
    assert.match(statement, /the 1 item listed on high-value declaration HVI-00001 is described/);
    assert.match(statement, /\$350\.00 in total/);
    assert.match(statement, /AI estimates are estimates/);
  });
});
