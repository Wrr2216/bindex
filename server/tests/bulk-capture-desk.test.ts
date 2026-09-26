import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { DESK_PHOTO } from "./bulk-capture-fixtures";

// Desk surveys: what each desk should have, what it has, and the settings
// that hold the templates and the cost cap.

type Desk = typeof import("../src/services/bulk-capture/desk");
type Detections = typeof import("../src/services/bulk-capture/detections");
type Settings = typeof import("../src/services/bulk-capture/settings");
let desk: Desk;
let det: Detections;
let settings: Settings;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://test/test";
  process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
  desk = await import("../src/services/bulk-capture/desk");
  det = await import("../src/services/bulk-capture/detections");
  settings = await import("../src/services/bulk-capture/settings");
});

const draft = (name: string, qty = 1, area: string | null = "4B-12", category: string | null = null, status = "pending") => ({
  name,
  qty,
  area,
  category,
  status,
});

describe("checkDesks", () => {
  it("flags what a desk is missing against the standard template", () => {
    const reading = det.normalizePhotoReading(DESK_PHOTO)!;
    assert.equal(reading.deskLabel, "4B-12");
    const drafts = reading.items.map((i) => draft(i.name, i.qty, "4B-12", i.category));
    const [check] = desk.checkDesks(drafts, desk.DEFAULT_DESK_TEMPLATE, ["4B-12"]);
    assert.equal(check!.desk, "4B-12");
    assert.equal(check!.complete, false);
    assert.deepEqual(
      check!.lines.map((l) => [l.key, l.expected, l.found, l.missing]),
      [
        ["monitor", 2, 1, 1],
        ["dock", 1, 0, 1],
        ["chair", 1, 1, 0],
        ["pedestal", 1, 1, 0],
      ],
    );
    // A monitor arm is not a monitor; it and the keyboard are listed as other things.
    assert.deepEqual(check!.others.map((o) => o.name), ["monitor arm", "keyboard"]);
  });

  it("marks a fully kitted desk complete and counts extras", () => {
    const [check] = desk.checkDesks(
      [
        draft("Dell monitor", 3),
        draft("docking station"),
        draft("office chair"),
        draft("drawer unit"),
      ],
      desk.DEFAULT_DESK_TEMPLATE,
      [],
    );
    assert.equal(check!.complete, true);
    assert.equal(check!.lines[0]!.extra, 1);
  });

  it("lists a desk with photos but nothing recognised as missing everything", () => {
    const checks = desk.checkDesks([draft("chair", 1, "Desk 1")], desk.DEFAULT_DESK_TEMPLATE, ["Desk 1", "Desk 2", null]);
    assert.deepEqual(checks.map((c) => c.desk), ["Desk 1", "Desk 2", "Unlabelled desk"]);
    assert.equal(checks[1]!.lines.every((l) => l.found === 0), true);
  });

  it("ignores deleted entries and counts a monitor known only by its category", () => {
    const [check] = desk.checkDesks(
      [draft("chair", 1, "D1", null, "discarded"), draft("LG UltraFine 27", 2, "D1", "Monitor")],
      desk.DEFAULT_DESK_TEMPLATE,
      ["D1"],
    );
    assert.equal(check!.lines.find((l) => l.key === "chair")!.found, 0);
    assert.equal(check!.lines.find((l) => l.key === "monitor")!.found, 2);
  });

  it("matches desk names without regard to case", () => {
    const checks = desk.checkDesks([draft("chair", 1, "desk 4")], desk.DEFAULT_DESK_TEMPLATE, ["Desk 4"]);
    assert.equal(checks.length, 1);
  });
});

describe("templates and settings", () => {
  it("cleans a template and fills in keys and match words", () => {
    const t = desk.normalizeTemplate({
      name: " Hot desk ",
      items: [
        { label: "Monitor", qty: 1 },
        { label: "Monitor", qty: 2 },
        { label: "Headset", qty: 50, match: ["headset", " Headphones ", 3] },
        { label: "" },
      ],
    })!;
    assert.deepEqual(t, {
      id: "hot-desk",
      name: "Hot desk",
      items: [
        { key: "monitor", label: "Monitor", qty: 1, match: ["monitor"] },
        { key: "headset", label: "Headset", qty: 20, match: ["headset", "headphones"] },
      ],
    });
    assert.equal(desk.normalizeTemplate({ name: "Empty", items: [] }), null);
    assert.equal(desk.normalizeTemplate("nope"), null);
  });

  it("keeps the cap within bounds and falls back to the defaults", () => {
    assert.deepEqual(settings.normalizeSettings(null), settings.DEFAULT_SETTINGS);
    assert.equal(settings.normalizeSettings({ maxImagesPerSession: 10_000 }).maxImagesPerSession, settings.MAX_IMAGE_CAP);
    assert.equal(settings.normalizeSettings({ maxImagesPerSession: 0 }).maxImagesPerSession, 1);
    assert.equal(settings.normalizeSettings({ maxImagesPerSession: "12" }).maxImagesPerSession, settings.DEFAULT_IMAGE_CAP);
    assert.deepEqual(settings.normalizeSettings({ deskTemplates: [{ name: "x" }] }).deskTemplates, [desk.DEFAULT_DESK_TEMPLATE]);
    const two = settings.normalizeSettings({
      deskTemplates: [
        { id: "a", name: "A", items: [{ label: "Chair", qty: 1 }] },
        { id: "a", name: "A again", items: [{ label: "Chair", qty: 1 }] },
      ],
    });
    assert.equal(two.deskTemplates.length, 1);
  });

  it("asks the model about the template in desk mode", () => {
    const prompt = det.deskPrompt("4B-12", desk.DEFAULT_DESK_TEMPLATE);
    assert.match(prompt, /2 × monitor, 1 × docking station, 1 × chair, 1 × pedestal/);
    assert.match(prompt, /\(4B-12\)/);
    assert.match(det.walkthroughPrompt("Room 101"), /photo of Room 101/);
  });
});
