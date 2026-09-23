import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import { rateLimit } from "../src/lib/rateLimit";
import { HttpError } from "../src/lib/errors";

function call(limiter: ReturnType<typeof rateLimit>, key: string): unknown {
  const req = { key } as unknown as Request;
  const res = { setHeader() {} } as unknown as Response;
  let result: unknown = "not called";
  limiter(req, res, (err?: unknown) => {
    result = err;
  });
  return result;
}

describe("rate limit", () => {
  const limiter = () =>
    rateLimit({ windowMs: 60_000, max: 3, key: (req) => (req as unknown as { key: string }).key });

  it("lets requests through up to the limit", () => {
    const l = limiter();
    for (let i = 0; i < 3; i++) assert.equal(call(l, "a"), undefined);
  });

  it("rejects the request after the limit with a 429", () => {
    const l = limiter();
    for (let i = 0; i < 3; i++) call(l, "a");
    const err = call(l, "a");
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 429);
  });

  it("counts each key separately", () => {
    const l = limiter();
    for (let i = 0; i < 3; i++) call(l, "a");
    assert.equal(call(l, "b"), undefined);
  });
});
