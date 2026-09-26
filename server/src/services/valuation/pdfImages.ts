import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";

/**
 * PDF receipts, drawn as images for the vision model. Uses pdftoppm from
 * poppler-utils when it is on the PATH (the Docker image installs it). Without
 * it, PDF receipts are still stored and can be entered by hand; only reading
 * them with AI needs it, and photos of receipts work either way.
 */

let found: string | null | undefined;

/** The pdftoppm executable on the PATH, or null. Looked up once. */
export function pdftoppmPath(): string | null {
  if (found !== undefined) return found;
  found = null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      found = candidate;
      break;
    } catch {
      // not here
    }
  }
  return found;
}

export const pdfReadingAvailable = (): boolean => pdftoppmPath() !== null;

const TIMEOUT_MS = 30_000;

/**
 * The first `maxPages` pages of a PDF as PNGs at 150 dpi, enough for small
 * receipt print. Null when pdftoppm is missing or the PDF cannot be drawn.
 */
export async function pdfToImages(bytes: Buffer, maxPages = 3): Promise<Buffer[] | null> {
  const bin = pdftoppmPath();
  if (!bin) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bindex-receipt-"));
  try {
    const input = path.join(dir, "in.pdf");
    await fsp.writeFile(input, bytes);
    await new Promise<void>((resolve, reject) => {
      execFile(
        bin,
        ["-r", "150", "-png", "-f", "1", "-l", String(maxPages), input, path.join(dir, "page")],
        { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, _stdout, stderr) => (err ? reject(new Error(`${err.message} ${String(stderr).slice(0, 200)}`)) : resolve()),
      );
    });
    const pages = (await fsp.readdir(dir)).filter((f) => /^page-\d+\.png$/.test(f)).sort();
    const out: Buffer[] = [];
    for (const f of pages) out.push(await fsp.readFile(path.join(dir, f)));
    return out.length ? out : null;
  } catch (err) {
    logger.warn("valuation.pdf_render.failed", { err: describeError(err) });
    return null;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
