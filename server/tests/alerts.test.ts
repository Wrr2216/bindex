import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { afterEach, before, describe, it } from "node:test";

/**
 * Pushover and Wazuh delivery. The Wazuh line format is a contract with the
 * manager's shared mct-alert decoder, so it is pinned here byte for byte.
 */

process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.LOG_LEVEL ??= "error";

const ALERT_ENV = [
  "PUSHOVER_TOKEN",
  "PUSHOVER_USER",
  "PUSHOVER_DEVICE",
  "PUSHOVER_ENABLED",
  "WAZUH_HOST",
  "WAZUH_PORT",
  "WAZUH_PROTOCOL",
  "WAZUH_ENABLED",
];

let wazuh: typeof import("../src/lib/wazuh");
let notifier: typeof import("../src/lib/notify");
const realFetch = globalThis.fetch;

before(async () => {
  wazuh = await import("../src/lib/wazuh");
  notifier = await import("../src/lib/notify");
});

afterEach(() => {
  for (const key of ALERT_ENV) delete process.env[key];
  globalThis.fetch = realFetch;
});

describe("Wazuh alert line", () => {
  const at = new Date("2026-09-08T12:00:00Z");

  it("wraps a JSON payload in an RFC 3164 envelope tagged mct-alert", () => {
    const line = wazuh.formatAlert({ app: "Bindex", title: "Tracker", message: "Battery low", priority: 1 }, at);
    const match = /^<131>Sep  8 12:00:00 (\S+) mct-alert: (.+)$/.exec(line);
    assert.ok(match, line);
    assert.deepEqual(JSON.parse(match[2]!), {
      app: "Bindex",
      title: "Tracker",
      message: "Battery low",
      priority: 1,
      event: "notification",
      ts: "2026-09-08T12:00:00.000Z",
    });
  });

  it("maps priority to syslog severity", () => {
    const pri = (priority: number) =>
      wazuh.formatAlert({ app: "a", title: "t", message: "m", priority }, at).slice(0, 5);
    assert.equal(pri(2), "<131>");
    assert.equal(pri(0), "<133>");
    assert.equal(pri(-1), "<134>");
  });

  it("cuts long titles and messages by character, not byte", () => {
    const line = wazuh.formatAlert({ app: "a", title: "🔔".repeat(300), message: "x".repeat(2000), priority: 0 }, at);
    const payload = JSON.parse(line.slice(line.indexOf("{"))) as { title: string; message: string };
    assert.equal(Array.from(payload.title).length, 250);
    assert.equal(payload.message.length, 1024);
  });
});

describe("Wazuh delivery", () => {
  const event = { app: "Bindex", title: "t", message: "m", priority: 0 };

  it("is off without a host, or when disabled", async () => {
    assert.equal(await wazuh.sendWazuh(event), false);
    process.env.WAZUH_HOST = "127.0.0.1";
    process.env.WAZUH_ENABLED = "false";
    assert.equal(await wazuh.sendWazuh(event), false);
  });

  it("refuses an unknown protocol", async () => {
    process.env.WAZUH_HOST = "127.0.0.1";
    process.env.WAZUH_PROTOCOL = "http";
    assert.equal(await wazuh.sendWazuh(event), false);
  });

  it("writes one newline-terminated line over TCP", async () => {
    const received: string[] = [];
    const server = createServer((socket) => {
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => received.push(data));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      process.env.WAZUH_HOST = "127.0.0.1";
      process.env.WAZUH_PORT = String((server.address() as AddressInfo).port);
      assert.equal(await wazuh.sendWazuh(event), true);
      for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(received.length, 1);
      assert.match(received[0]!, /^<133>.* mct-alert: \{.*"event":"notification".*\}\n$/);
    } finally {
      server.close();
    }
  });
});

describe("notify", () => {
  type Sent = { url: string; body: Record<string, unknown> };

  function stubPushover(reply: { ok: boolean; status: number; body: unknown }): Sent[] {
    const sent: Sent[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch;
    return sent;
  }

  it("posts to Pushover with the device and mapped priority", async () => {
    process.env.PUSHOVER_TOKEN = "tok";
    process.env.PUSHOVER_USER = "usr";
    process.env.PUSHOVER_DEVICE = "phone";
    const sent = stubPushover({ ok: true, status: 200, body: { status: 1 } });
    assert.equal(await notifier.notify({ title: "Low stock", message: "Tape", priority: "high" }), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, "https://api.pushover.net/1/messages.json");
    assert.deepEqual(sent[0]!.body, {
      token: "tok",
      user: "usr",
      title: "Low stock",
      message: "Tape",
      priority: 1,
      device: "phone",
    });
  });

  it("asks Pushover to repeat emergency alerts", async () => {
    process.env.PUSHOVER_TOKEN = "tok";
    process.env.PUSHOVER_USER = "usr";
    const sent = stubPushover({ ok: true, status: 200, body: { status: 1 } });
    await notifier.notify({ title: "t", message: "m", priority: "max" });
    assert.equal(sent[0]!.body.priority, 2);
    assert.equal(sent[0]!.body.retry, 60);
    assert.equal(sent[0]!.body.expire, 3600);
  });

  it("sends nothing to Pushover without both keys, or when disabled", async () => {
    const sent = stubPushover({ ok: true, status: 200, body: { status: 1 } });
    process.env.PUSHOVER_TOKEN = "tok";
    assert.equal(await notifier.notify({ title: "t", message: "m" }), false);
    process.env.PUSHOVER_USER = "usr";
    process.env.PUSHOVER_ENABLED = "false";
    assert.equal(await notifier.notify({ title: "t", message: "m" }), false);
    assert.equal(sent.length, 0);
  });

  it("reports a rejected message as not delivered", async () => {
    process.env.PUSHOVER_TOKEN = "tok";
    process.env.PUSHOVER_USER = "usr";
    stubPushover({ ok: false, status: 400, body: { status: 0, errors: ["user key is invalid"] } });
    assert.equal(await notifier.notify({ title: "t", message: "m" }), false);
  });
});
