/** Error carrying an HTTP status + stable machine code for the API error shape. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, "bad_request", msg, details);
export const unauthorized = (msg = "Not authenticated") =>
  new HttpError(401, "unauthorized", msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, "forbidden", msg);
export const notFound = (msg = "Not found") => new HttpError(404, "not_found", msg);
export const conflict = (msg: string) => new HttpError(409, "conflict", msg);

/** Human-readable error string that unwraps AggregateError and `cause` chains. */
export function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    return `AggregateError: ${err.errors.map((e) => describeError(e)).join("; ")}`;
  }
  if (err instanceof Error) {
    return err.cause ? `${err.message} (cause: ${describeError(err.cause)})` : err.message;
  }
  return String(err);
}

const PG_UNIQUE_VIOLATION = "23505";

/**
 * True when `err` is a Postgres unique-violation on `constraint`.
 *
 * Drizzle wraps driver errors in its own Error whose message is the SQL text, so
 * the constraint name only survives on the `cause` chain, so matching against
 * `String(err)` silently never fires and turns a 409 into a 500.
 */
export function isUniqueViolation(err: unknown, ...constraints: string[]): boolean {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 10; depth++) {
    const e = cur as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (e.code === PG_UNIQUE_VIOLATION) {
      const detail = `${String(e.constraint ?? "")} ${String(e.message ?? "")}`;
      return constraints.some((c) => detail.includes(c));
    }
    cur = e.cause;
  }
  return false;
}
