import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startSmtpStub } from "./portal-smtp-stub";

/**
 * Portal email through a real nodemailer SMTP transport, against the
 * in-process stub server. SMTP_URL has to be set before the environment
 * module loads, so the stub starts first and the mailer is imported after.
 */

process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";

describe("portal mail over SMTP", () => {
  let stub: Awaited<ReturnType<typeof startSmtpStub>>;
  let mailer: typeof import("../src/services/portal/mailer");

  before(async () => {
    stub = await startSmtpStub();
    process.env.SMTP_URL = `smtp://127.0.0.1:${stub.port}`;
    process.env.SMTP_FROM = "Bindex Portal <portal@example.com>";
    mailer = await import("../src/services/portal/mailer");
  });

  after(async () => {
    await stub?.close();
  });

  it("is available when SMTP_URL is set, and delivers a plain-text message", async () => {
    assert.equal(mailer.mailAvailable(), true);
    const ok = await mailer.sendMail(
      { to: "dana@example.com", subject: "Acme: Truck 1 is on its way", text: "Hello Dana,\n\n  - Truck 1 is on its way\n.\n" },
      "Bindex",
    );
    assert.equal(ok, true);
    assert.equal(stub.messages.length, 1);
    const m = stub.messages[0]!;
    assert.equal(m.from, "portal@example.com");
    assert.deepEqual(m.to, ["dana@example.com"]);
    assert.match(m.data, /^Subject: Acme: Truck 1 is on its way$/m);
    assert.match(m.data, /^To: dana@example\.com$/m);
    assert.match(m.data, /Truck 1 is on its way/);
  });

  it("reports failure without throwing when the server is gone", async () => {
    await stub.close();
    const ok = await mailer.sendMail({ to: "dana@example.com", subject: "x", text: "y" }, "Bindex");
    assert.equal(ok, false);
  });
});
