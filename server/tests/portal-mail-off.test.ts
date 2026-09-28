import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

/** With SMTP_URL blank, email is simply unavailable, and nodemailer is never loaded. */

process.env.DATABASE_URL ??= "postgres://test/test";
process.env.SESSION_SECRET ??= "test-secret-at-least-16-chars";
process.env.SMTP_URL = "";

describe("portal mail with SMTP unset", () => {
  let mailer: typeof import("../src/services/portal/mailer");

  before(async () => {
    mailer = await import("../src/services/portal/mailer");
  });

  it("reports unavailable and sends nothing, quietly", async () => {
    assert.equal(mailer.mailAvailable(), false);
    assert.equal(await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" }, "Bindex"), false);
    assert.ok(!Object.keys(require.cache).some((k) => k.includes(`${"node_modules"}/nodemailer`)), "nodemailer was loaded");
  });

  it("uses a transport handed to it, as tests do", async () => {
    const sent: string[] = [];
    mailer.setMailTransport({ sendMail: async (m) => void sent.push(`${m.from} -> ${m.to}: ${m.subject}`) });
    try {
      assert.equal(mailer.mailAvailable(), true);
      assert.equal(await mailer.sendMail({ to: "a@example.com", subject: "s", text: "t" }, "Acme \"Stores\""), true);
      assert.deepEqual(sent, ['"Acme Stores" <no-reply@localhost> -> a@example.com: s']);
    } finally {
      mailer.setMailTransport(null);
    }
    assert.equal(mailer.mailAvailable(), false);
  });
});
