import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { isWorkingTime, localTime, parseWorkHours, validTimeZone } from "../src/services/ble/hours";
import { CalibrationStore, summarizeCalibration } from "../src/services/ble/calibrate";
import { HeardNearby } from "../src/services/ble/heard";
import { interpretAdvert } from "../src/services/ble/adapters";

/**
 * Pure helpers around the presence engine: working hours, calibration, the
 * heard-nearby list, alert digests and the MQTT subscriber (against an
 * in-process stub client; no broker needed).
 */

process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.LOG_LEVEL ??= "error";

describe("working hours", () => {
  it("parses day ranges, lists, several ranges and overnight shifts", () => {
    const s = parseWorkHours("Mon-Fri 07:00-12:00, 13:00-17:30; Sat 08:00-12:00; Sun 22:00-06:00");
    assert.deepEqual(s.days[2], [
      [420, 720],
      [780, 1050],
    ]);
    assert.deepEqual(s.days[6], [[480, 720]]);
    assert.deepEqual(s.days[0], [[1320, 1440]]);
    // Sunday night runs into Monday morning.
    assert.deepEqual(s.days[1], [
      [420, 720],
      [780, 1050],
      [0, 360],
    ]);
    assert.equal(parseWorkHours("Daily 06:00-22:00").days.every((d) => d.length === 1), true);
    assert.deepEqual(parseWorkHours("Fri-Mon 09:00-10:00").days.map((d) => d.length), [1, 1, 0, 0, 0, 1, 1]);
  });

  it("says what is wrong with a bad schedule", () => {
    assert.throws(() => parseWorkHours(""), /No working hours/);
    assert.throws(() => parseWorkHours("Weekdays 07:00-19:00"), /not a day/);
    assert.throws(() => parseWorkHours("Mon-Fri 7am-7pm"), /should look like/);
    assert.throws(() => parseWorkHours("Mon 25:00-26:00"), /not a time of day/);
    assert.throws(() => parseWorkHours("Mon 07:00-07:00"), /same time/);
  });

  it("checks a moment in a given time zone", () => {
    const s = parseWorkHours("Mon-Fri 07:00-19:00");
    // Wednesday 2026-09-23 12:00 UTC.
    const noonUtc = new Date("2026-09-23T12:00:00Z");
    assert.equal(isWorkingTime(noonUtc, s, "UTC"), true);
    // The same instant is 22:00 in Sydney: after hours.
    assert.equal(isWorkingTime(noonUtc, s, "Australia/Sydney"), false);
    // Saturday.
    assert.equal(isWorkingTime(new Date("2026-09-26T12:00:00Z"), s, "UTC"), false);
    // The end is exclusive.
    assert.equal(isWorkingTime(new Date("2026-09-23T19:00:00Z"), s, "UTC"), false);
    assert.deepEqual(localTime(new Date("2026-09-23T00:30:00Z"), "UTC"), { day: 3, minute: 30 });
    assert.equal(validTimeZone("Europe/London"), true);
    assert.equal(validTimeZone("Mars/Olympus"), false);
  });
});

describe("calibration", () => {
  const gateways = [
    { id: "g-dock", name: "Dock A gateway", zoneId: "dock", offset: 0 },
    { id: "g-aisle", name: "Aisle 3 gateway", zoneId: "aisle", offset: 0 },
    { id: "g-roam", name: "Forklift", zoneId: null, offset: 0 },
  ];

  it("confirms a room that wins by the margin", () => {
    const s = summarizeCalibration(
      new Map([
        ["g-dock", [-60, -61, -59, -62, -60]],
        ["g-aisle", [-75, -78, -74]],
        ["g-roam", [-40]],
      ]),
      gateways,
      "dock",
      6,
    );
    assert.equal(s.ok, true);
    assert.equal(s.winnerZoneId, "dock");
    assert.equal(s.margin, 15);
    assert.deepEqual(s.suggestions, []);
    // Strongest first, the zoneless forklift included but not counted.
    assert.deepEqual(
      s.gateways.map((g) => g.gatewayId),
      ["g-roam", "g-dock", "g-aisle"],
    );
    assert.equal(s.gateways[1]!.medianRaw, -60);
  });

  it("suggests an offset when the neighbouring room hears the tag better", () => {
    const s = summarizeCalibration(
      new Map([
        ["g-dock", [-72, -71, -73]],
        ["g-aisle", [-68, -69, -67]],
      ]),
      [{ ...gateways[0]!, offset: 2 }, gateways[1]!],
      "dock",
      6,
    );
    // Dock reads -72 + 2 = -70 against -68: 2 dB behind, and it needs to lead by 6.
    assert.equal(s.ok, false);
    assert.equal(s.winnerZoneId, "aisle");
    assert.equal(s.margin, -2);
    assert.deepEqual(s.suggestions, [
      { gatewayId: "g-dock", name: "Dock A gateway", currentOffset: 2, suggestedOffset: 11 },
    ]);
    assert.match(s.notes.join(" "), /calibrate the neighbouring room/);
  });

  it("explains when no gateway in the room hears the tag, or none exists", () => {
    const heardElsewhere = new Map([["g-aisle", [-70]]]);
    assert.match(summarizeCalibration(heardElsewhere, gateways, "dock", 6).notes[0]!, /did not hear/);
    assert.match(summarizeCalibration(heardElsewhere, gateways, "office", 6).notes[0]!, /No gateway is installed/);
    assert.match(summarizeCalibration(new Map(), gateways, "dock", 6).notes[0]!, /No gateway heard the tag/);
  });

  it("records readings for the tag and the time a session runs", () => {
    const store = new CalibrationStore();
    const s = store.start({ tagKey: "tag-1", tagName: "Pallet jack", locationId: "dock", durationMs: 60_000 }, 1_000);
    store.feed("tag-1", "g-dock", -60, 2_000);
    store.feed("tag-1", "g-dock", -61, 3_000);
    store.feed("tag-2", "g-dock", -50, 3_000);
    store.feed("tag-1", "g-aisle", -80, 70_000);
    assert.deepEqual([...store.get(s.id)!.samples], [["g-dock", [-60, -61]]]);
    store.stop(s.id, 30_000);
    assert.equal(store.get(s.id)!.endsAt, 30_000);
    assert.equal(store.cancel(s.id), true);
    assert.equal(store.get(s.id), undefined);
  });
});

describe("heard nearby", () => {
  const obs = (identity: string | null, mac: string | null, rssi: number, frame = "ibeacon") =>
    ({ ...interpretAdvert({ identity, mac, rssi }), frame }) as ReturnType<typeof interpretAdvert>;

  it("keeps the latest reading per advertiser, strongest first, and forgets after ten minutes", () => {
    const h = new HeardNearby();
    h.add("gw", obs("ibeacon:e2c56db5-dffb-48d2-b060-d0f5a71096e0:1:2", "AC233FA1B2C3", -70), 1000);
    h.add("gw", obs("ibeacon:e2c56db5-dffb-48d2-b060-d0f5a71096e0:1:2", "AC233FA1B2C3", -65), 2000);
    h.add("gw", obs(null, "AABBCCDDEEFF", -50, "none"), 2000);
    const all = h.list({ now: 3000 });
    assert.equal(all.length, 2);
    assert.equal(all[0]!.frame, "none");
    assert.equal(all[1]!.count, 2);
    assert.equal(all[1]!.rssi, -65);
    assert.equal(h.list({ now: 3000, beaconsOnly: true }).length, 1);
    assert.equal(h.list({ now: 2000 + 10 * 60_000 + 1 }).length, 0);
  });
});

describe("alert digests", () => {
  it("describes each alert and counts them in the title", async () => {
    const { describeAlert, digestTitle } = await import("../src/services/ble/alerts");
    const createdAt = new Date().toISOString();
    const alerts = [
      { kind: "missing" as const, createdAt, detail: { itemName: "Pallet jack 2", minutes: 10, locationName: "Dock A" } },
      { kind: "after_hours_move" as const, createdAt, detail: { itemName: "Vault 12", fromName: "Vault room", toName: "Dock A" } },
      { kind: "battery_low" as const, createdAt, detail: { name: "Tag 7", batteryPct: 12 } },
      { kind: "battery_low" as const, createdAt, detail: { identity: "mac:AC:23:3F:A1:B2:C3", batteryPct: 3 } },
    ];
    assert.deepEqual(alerts.map(describeAlert), [
      "Pallet jack 2: not heard for 10 min, last in Dock A",
      "Vault 12: moved from Vault room to Dock A out of hours",
      "Tag 7: battery at 12%",
      "mac:AC:23:3F:A1:B2:C3: battery at 3%",
    ]);
    assert.equal(digestTitle(alerts), "Bluetooth tags: 1 missing, 1 moved out of hours, 2 low batteries");
  });
});

class StubClient extends EventEmitter {
  subscribed: string[] = [];
  ended = false;
  subscribe(topics: string[], _opts: unknown, cb?: (err: Error | null) => void) {
    this.subscribed.push(...topics);
    cb?.(null);
  }
  end() {
    this.ended = true;
  }
}

describe("MQTT subscriber", () => {
  it("matches topics and finds the gateway in the first + segment", async () => {
    const { matchTopic, redactUrl } = await import("../src/services/ble/mqtt");
    assert.deepEqual(matchTopic("bindex/ble/+", "bindex/ble/AC233FC04EAB"), { match: true, gateway: "AC233FC04EAB" });
    assert.deepEqual(matchTopic("bindex/ble/+", "bindex/ble/a/b"), { match: false, gateway: null });
    assert.deepEqual(matchTopic("gw/+/status", "gw/E1C8BC3DFF84/status"), { match: true, gateway: "E1C8BC3DFF84" });
    assert.deepEqual(matchTopic("site/#", "site/dock/gw1"), { match: true, gateway: null });
    assert.deepEqual(matchTopic("site/+/#", "site/dock/gw1"), { match: true, gateway: "dock" });
    assert.equal(matchTopic("a/b", "a/c").match, false);
    assert.equal(redactUrl("mqtt://bindex:s3cret@broker:1883"), "mqtt://bindex:****@broker:1883");
  });

  it("subscribes on connect and hands each report to the handler in order", async () => {
    const { startBleMqtt, mqttStatus } = await import("../src/services/ble/mqtt");
    const client = new StubClient();
    let connectedWith: { url: string; opts: Record<string, unknown> } | null = null;
    const handled: { gateway: string; adverts: number }[] = [];
    const handle = await startBleMqtt({
      url: "mqtt://user:pw@broker.test:1883",
      topics: ["bindex/ble/+", "gw/+/status"],
      format: "auto",
      connect: (url, opts) => {
        connectedWith = { url, opts };
        return client;
      },
      handle: async (gateway, payload) => {
        // A slow first message must not let the second overtake it.
        if (!handled.length) await new Promise((r) => setTimeout(r, 20));
        handled.push({ gateway, adverts: payload.adverts.length });
      },
    });
    assert.ok(handle);
    assert.equal(connectedWith!.url, "mqtt://user:pw@broker.test:1883");
    client.emit("connect");
    assert.deepEqual(client.subscribed, ["bindex/ble/+", "gw/+/status"]);
    assert.equal(mqttStatus().connected, true);
    assert.equal(mqttStatus().url, "mqtt://user:****@broker.test:1883");

    // Minew names itself in the payload; the generic report is named by the topic.
    const minew = JSON.stringify([
      { type: "Gateway", mac: "AC233FC04EAB" },
      { type: "Unknown", mac: "AC233F266BF2", rssi: -60, rawData: "0201061AFF4C000215E2C56DB5DFFB48D2B060D0F5A71096E000010002C5" },
    ]);
    client.emit("message", "bindex/ble/ignored-because-payload-names-it", Buffer.from(minew));
    client.emit("message", "bindex/ble/pi-aisle-3", Buffer.from('{"reads":[{"mac":"AC233FA1B2C3","rssi":-70},{"code":"AC233FA1B2C4","rssi":-75}]}'));
    // No gateway anywhere, and a message that is not a report: both rejected, neither stops the others.
    client.emit("message", "other/topic", Buffer.from('{"reads":[{"mac":"AC233FA1B2C3","rssi":-70}]}'));
    client.emit("message", "bindex/ble/x", Buffer.from("garbage"));
    client.emit("message", "gw/E1C8BC3DFF84/status", Buffer.from("$GPRP,C4BE84E7EC3E,E1C8BC3DFF84,-58,0201"));

    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(handled, [
      { gateway: "AC233FC04EAB", adverts: 1 },
      { gateway: "pi-aisle-3", adverts: 2 },
      { gateway: "E1:C8:BC:3D:FF:84", adverts: 1 },
    ]);
    assert.equal(mqttStatus().messages, 5);
    assert.equal(mqttStatus().rejected, 2);

    client.emit("close");
    assert.equal(mqttStatus().connected, false);
    handle!.stop();
    assert.equal(client.ended, true);
  });

  it("does nothing when no broker is configured", async () => {
    const { startBleMqtt } = await import("../src/services/ble/mqtt");
    assert.equal(await startBleMqtt({ url: "" }), null);
  });
});
