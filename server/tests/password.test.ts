import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_PASSWORD_LENGTH,
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
} from "../src/lib/password";

describe("password hashing", () => {
  it("accepts the password it was given", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  });

  it("rejects a different password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("correct horse battery stapl", hash), false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same password", a), true);
    assert.equal(await verifyPassword("same password", b), true);
  });

  it("records its cost parameters, so they can be raised later", async () => {
    const [scheme, n, r, p] = (await hashPassword("x")).split("$");
    assert.equal(scheme, "scrypt");
    assert.ok(Number(n) >= 1 << 16, "work factor should be at least 2^16");
    assert.equal(r, "8");
    assert.equal(p, "1");
  });

  it("normalises unicode, so either way of typing an accent matches", async () => {
    // The same word twice: once with a precomposed e-acute, once with a plain e
    // followed by a combining accent. Keyboards and phones produce both.
    const precomposed = "caf\u00e9-passphrase";
    const decomposed = "cafe\u0301-passphrase";
    assert.notEqual(precomposed, decomposed);

    const hash = await hashPassword(precomposed);
    assert.equal(await verifyPassword(decomposed, hash), true);
  });

  it("treats an unparseable hash as a failed sign-in rather than throwing", async () => {
    for (const stored of ["", "not-a-hash", "scrypt$1$2$3", "bcrypt$a$b$c$d$e"]) {
      assert.equal(await verifyPassword("anything", stored), false);
    }
  });
});

describe("password strength", () => {
  it("requires a minimum length", () => {
    assert.ok(checkPasswordStrength("a".repeat(MIN_PASSWORD_LENGTH - 1)));
    assert.equal(checkPasswordStrength("a".repeat(MIN_PASSWORD_LENGTH)), null);
  });

  it("rejects one long enough to be a denial of service", () => {
    assert.ok(checkPasswordStrength("a".repeat(513)));
  });
});
