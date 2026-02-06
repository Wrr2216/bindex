import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodSchema } from "zod";
import { badRequest } from "./errors";

/** Wrap an async handler so thrown/rejected errors reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Validate a payload with Zod, throwing a 400 with field details on failure. */
export function parse<T>(schema: ZodSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest("Validation failed", result.error.flatten());
  }
  return result.data;
}

/** Read a required string route parameter (Express 5 types params loosely). */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw badRequest(`Missing route parameter: ${name}`);
  return value;
}
