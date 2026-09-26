import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { ExportChecker, type ChainRow, type ExportCheck } from "./canonical";

/**
 * Check an NDJSON audit-log export without a database or a running server:
 *
 *   pnpm --filter bindex-server exec tsx src/services/event-backbone/verifyExport.ts audit-log.ndjson
 *
 * Exits 0 when every row matches its hash and every adjacent pair links, 1
 * otherwise. Imports only canonical.ts, so it needs no configuration.
 */

export async function verifyExportFile(path: string): Promise<ExportCheck> {
  const checker = new ExportChecker();
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (!checker.push(JSON.parse(line) as ChainRow)) break;
  }
  return checker.finish();
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("Usage: verifyExport.ts <audit-log.ndjson>\n");
    process.exit(2);
  }
  verifyExportFile(file)
    .then((r) => {
      if (!r.ok) {
        process.stdout.write(`BROKEN at id ${r.firstBadId}: ${r.reason} (after ${r.rows - 1} good rows)\n`);
        process.exit(1);
      }
      process.stdout.write(
        `OK: ${r.rows} rows, each matching its hash; ${r.links} links checked.\n` +
          (r.startsAtGenesis
            ? "Starts at the beginning of the log.\n"
            : "Starts part-way through the log (archived, or a filtered export).\n") +
          (r.gaps
            ? `${r.gaps} gap(s) where rows are absent from the file: expected for a filtered export, a sign of removed rows in a full one.\n`
            : ""),
      );
    })
    .catch((err: unknown) => {
      process.stderr.write(`Could not read the export: ${String(err)}\n`);
      process.exit(2);
    });
}
