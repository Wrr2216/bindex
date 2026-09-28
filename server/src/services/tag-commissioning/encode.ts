import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../../db/client";
import { items, locations } from "../../db/schema";
import { env } from "../../env";
import { badRequest } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { getUnitLabelInfo, unitSubLine } from "../units";
import { encodeBindex96 } from "./epc";
import { ensureEpcs, markEncoded, targetKey, type EpcTarget } from "./epcAssign";
import { encodeCsv, zplDocument, type ZplLabel } from "./zpl";

/**
 * "Print and encode": the labels the print view would print, as ZPL for a
 * Zebra RFID printer that writes each record's EPC while it prints, or as a
 * code,EPC spreadsheet for any other encoder.
 *
 * Downloading records the EPCs as each record's RFID tag and freezes them, on
 * the reasoning that a file made for an encoder is about to be encoded. Pass
 * bind: false to only look.
 */

export const MAX_ENCODE = 1000;

export type EncodeRequest = {
  itemIds?: string[];
  unitIds?: string[];
  format: "zpl" | "csv";
  dpi: number;
  bind: boolean;
  /** A single made-up label for setting up a printer; nothing is recorded. */
  sample?: boolean;
};

type Row = EpcTarget & { name: string; sub: string | null; url: string };

const base = () => env.APP_BASE_URL.replace(/\/+$/, "");
const itemUrl = (id: string) => `${base()}/items/${id}`;

async function itemRows(ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({
      id: items.id,
      name: items.name,
      assetCode: items.assetCode,
      category: items.category,
      ninjaoneOrg: items.ninjaoneOrg,
      locationName: locations.name,
    })
    .from(items)
    .leftJoin(locations, eq(items.locationId, locations.id))
    .where(inArray(items.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Row[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    // Domains have nothing to stick a tag on; the PDF path refuses them too.
    if (!r || r.category === "Domain") continue;
    out.push({
      itemId: r.id,
      unitId: null,
      assetCode: r.assetCode,
      name: r.name,
      sub: r.ninjaoneOrg ?? r.locationName ?? null,
      url: itemUrl(r.id),
    });
  }
  return out;
}

async function unitRows(ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const id of ids) {
    const u = await getUnitLabelInfo(id);
    out.push({
      itemId: u.itemId,
      unitId: u.id,
      assetCode: u.assetCode,
      name: u.itemName,
      sub: unitSubLine(u),
      url: `${itemUrl(u.itemId)}?unit=${u.id}`,
    });
  }
  return out;
}

/** Record each EPC as its record's RFID tag, unless some other record has it. */
async function bindEpcs(rows: { itemId: string; unitId: string | null; epc: string }[]): Promise<number> {
  let bound = 0;
  for (const r of rows) {
    const { rows: inserted } = await pool.query<{ id: string }>(
      `INSERT INTO item_identifiers (item_id, type, value)
       SELECT $1, 'rfid', $2
        WHERE NOT EXISTS (
          SELECT 1 FROM item_identifiers
           WHERE type IN ('rfid', 'nfc')
             AND upper(regexp_replace(value, '[^0-9A-Za-z]', '', 'g')) = $2)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [r.itemId, r.epc],
    );
    const id = inserted[0]?.id;
    if (!id) continue;
    bound += 1;
    if (r.unitId) {
      await pool.query(
        "INSERT INTO tag_identifier_units (identifier_id, unit_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [id, r.unitId],
      );
    }
  }
  return bound;
}

export async function buildEncodeFile(req: EncodeRequest): Promise<{
  filename: string;
  contentType: string;
  body: string;
  count: number;
  bound: number;
}> {
  const options = { widthMm: env.LABEL_WIDTH_MM, heightMm: env.LABEL_HEIGHT_MM, dpi: req.dpi };
  const stamp = new Date().toISOString().slice(0, 10);

  if (req.sample) {
    const epc = encodeBindex96("TEST-000000")!;
    const label: ZplLabel = { name: "Sample label", code: "TEST-000000", sub: "Printer test", url: `${base()}/`, epc };
    return req.format === "zpl"
      ? { filename: "bindex-sample.zpl", contentType: "text/plain", body: zplDocument([label], options), count: 1, bound: 0 }
      : {
          filename: "bindex-sample.csv",
          contentType: "text/csv",
          body: encodeCsv([{ code: label.code, epc, scheme: "bindex-96", name: label.name, url: label.url! }]),
          count: 1,
          bound: 0,
        };
  }

  const itemIds = [...new Set(req.itemIds ?? [])];
  const unitIds = [...new Set(req.unitIds ?? [])];
  if (itemIds.length + unitIds.length === 0) throw badRequest("Choose at least one record to encode.");
  if (itemIds.length + unitIds.length > MAX_ENCODE) {
    throw badRequest(`Encode at most ${MAX_ENCODE} labels at a time.`);
  }

  const rows = [...(await itemRows(itemIds)), ...(await unitRows(unitIds))];
  if (!rows.length) throw badRequest("None of those records can carry a tag.");
  const epcs = await ensureEpcs(rows);

  const ready = rows.flatMap((r) => {
    const assigned = epcs.get(targetKey(r));
    return assigned ? [{ ...r, epc: assigned.epc, scheme: assigned.scheme, epcId: assigned.id }] : [];
  });

  let bound = 0;
  if (req.bind) {
    bound = await bindEpcs(ready);
    await markEncoded(ready.map((r) => r.epcId));
  }
  logger.info("tags.encode.export", { format: req.format, labels: ready.length, bound });

  if (req.format === "zpl") {
    const labels: ZplLabel[] = ready.map((r) => ({
      name: r.name,
      code: r.assetCode,
      sub: r.sub,
      url: r.url,
      epc: r.epc,
    }));
    return {
      filename: `bindex-labels-${stamp}.zpl`,
      contentType: "text/plain",
      body: zplDocument(labels, options),
      count: ready.length,
      bound,
    };
  }
  return {
    filename: `bindex-epcs-${stamp}.csv`,
    contentType: "text/csv",
    body: encodeCsv(
      ready.map((r) => ({ code: r.assetCode, epc: r.epc, scheme: r.scheme, name: r.name, url: r.url })),
    ),
    count: ready.length,
    bound,
  };
}
