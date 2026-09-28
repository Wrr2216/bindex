import { pool } from "../../db/client";
import type { ConditionRating, ContainerFlag, ContentLine } from "../../db/tables/ai-condition";
import { badRequest, notFound } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { actorFromOid, publish } from "../event-backbone";
import { recordEvent } from "../items";
import "./events";
import { assertPhotosOf, photoRefs, type PhotoRef } from "./photos";
import { getReport, insertReport, publishReportCreated } from "./reports";
import { getConditionSettings } from "./settings";
import { cleanLines, cleanText, normalizeFlags, normalizeQty } from "./vocab";

/**
 * Container capture: record what a box, tote or crate is (size class, the
 * writing on it, its handling marks) and turn its contents list into items
 * inside it, in one step.
 *
 * The contents become real items with parentItemId set to the container, so
 * everything that already understands nesting (contents sheets, container
 * labels, audits, spot checks) works on them unchanged.
 */

export type ContainerCapture = {
  id: string;
  itemId: string;
  sizeClass: string | null;
  handwrittenText: string | null;
  room: string | null;
  contentsSummary: string | null;
  contents: ContentLine[];
  flags: ContainerFlag[];
  confidence: Record<string, number> | null;
  aiAssisted: boolean;
  attachmentIds: string[];
  photos: PhotoRef[];
  createdItemIds: string[];
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
};

export type CaptureLineInput = {
  name: string;
  category?: string | null;
  qty?: number;
  condition?: ConditionRating | null;
  fragile?: boolean;
  description?: string | null;
  /** False to record the line without adding an item for it (it is already inside). */
  create?: boolean;
};

export type CaptureInput = {
  sizeClass?: string | null;
  handwrittenText?: string | null;
  room?: string | null;
  contentsSummary?: string | null;
  flags?: string[];
  contents?: CaptureLineInput[];
  attachmentIds?: string[];
  aiAssisted?: boolean;
  confidence?: Record<string, number> | null;
  /** Rename the container, for one created as "Box" before its writing was read. */
  containerName?: string | null;
  /** Put the new items at the container's location. Default true. */
  inheritLocation?: boolean;
};

type Row = {
  id: string;
  item_id: string;
  size_class: string | null;
  handwritten_text: string | null;
  room: string | null;
  contents_summary: string | null;
  contents: ContentLine[];
  flags: ContainerFlag[];
  confidence: Record<string, number> | null;
  ai_assisted: boolean;
  attachment_ids: string[];
  created_item_ids: string[];
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
};

async function present(rows: Row[]): Promise<ContainerCapture[]> {
  const photos = await photoRefs(rows.flatMap((r) => r.attachment_ids ?? []));
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    sizeClass: r.size_class,
    handwrittenText: r.handwritten_text,
    room: r.room,
    contentsSummary: r.contents_summary,
    contents: Array.isArray(r.contents) ? r.contents : [],
    flags: normalizeFlags(r.flags),
    confidence: r.confidence,
    aiAssisted: r.ai_assisted,
    attachmentIds: r.attachment_ids ?? [],
    photos: (r.attachment_ids ?? []).map((id) => photos.get(id)).filter((p): p is PhotoRef => Boolean(p)),
    createdItemIds: r.created_item_ids ?? [],
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  }));
}

const SELECT = `
  SELECT c.*, us.name AS created_by_name
    FROM container_captures c
    LEFT JOIN users us ON us.oid = c.created_by`;

/** Every capture of a container, newest first. */
export async function listCaptures(itemId: string): Promise<ContainerCapture[]> {
  const { rows } = await pool.query<Row>(`${SELECT} WHERE c.item_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 50`, [
    itemId,
  ]);
  return present(rows);
}

export async function getCapture(id: string): Promise<ContainerCapture | null> {
  const { rows } = await pool.query<Row>(`${SELECT} WHERE c.id = $1`, [id]);
  return rows[0] ? (await present(rows))[0]! : null;
}

export const MAX_LINES = 100;

const listSpelling = (v: string | null, list: readonly string[]) =>
  v ? list.find((e) => e.toLowerCase() === v.toLowerCase()) ?? v : null;
const FRAGILE_NOTE = "Fragile. Handle with care.";

/**
 * Validate and tidy a capture as a person confirmed it. Pure apart from the
 * configured lists, which are passed in.
 */
export function cleanCaptureInput(
  input: CaptureInput,
  lists: { sizeClasses: readonly string[]; categories: readonly string[] },
): {
  sizeClass: string | null;
  handwrittenText: string | null;
  room: string | null;
  contentsSummary: string | null;
  flags: ContainerFlag[];
  lines: (ContentLine & { create: boolean })[];
  containerName: string | null;
} {
  const lines = (input.contents ?? []).map((l, i) => {
    const name = cleanText(l.name, 120);
    if (!name) throw badRequest(`Line ${i + 1} has no name. Name it or remove the line.`);
    return {
      name,
      // What a person typed stands; only the spelling is taken from the list.
      category: listSpelling(cleanText(l.category, 60), lists.categories),
      qty: normalizeQty(l.qty),
      condition: l.condition ?? null,
      fragile: Boolean(l.fragile),
      description: cleanText(l.description, 300),
      create: l.create !== false,
    };
  });
  if (lines.length > MAX_LINES) throw badRequest(`Record at most ${MAX_LINES} lines per container.`);
  const flags = normalizeFlags(input.flags ?? []);
  // A person may use a size the list does not have (the list may have changed
  // since); keep it as given rather than lose it.
  const sizeClass = listSpelling(cleanText(input.sizeClass, 60), lists.sizeClasses);
  const category = (c: string | null) => (c && c.toLowerCase() === "domain" ? null : c);
  return {
    sizeClass,
    handwrittenText: cleanLines(input.handwrittenText, 2000),
    room: cleanText(input.room, 80),
    contentsSummary: cleanText(input.contentsSummary, 200),
    flags,
    lines: lines.map((l) => ({ ...l, category: category(l.category) })),
    containerName: cleanText(input.containerName, 200),
  };
}

export type CaptureResult = { capture: ContainerCapture; createdItemIds: string[]; reportIds: string[] };

/**
 * Save a confirmed capture. All or nothing: the new items, their pack-day
 * condition reports and the capture record commit together, and history
 * events and webhooks follow once they have.
 */
export async function saveCapture(containerId: string, input: CaptureInput, userOid: string | null): Promise<CaptureResult> {
  const lists = await getConditionSettings();
  const clean = cleanCaptureInput(input, lists);
  const attachmentIds = await assertPhotosOf(containerId, input.attachmentIds ?? [], 8);

  const client = await pool.connect();
  let captureId: string;
  const created: { id: string; name: string }[] = [];
  const reportIds: string[] = [];
  let renamed: { from: string; to: string } | null = null;
  try {
    await client.query("BEGIN");
    const { rows: found } = await client.query<{ id: string; name: string; category: string | null; location_id: string | null }>(
      "SELECT id, name, category, location_id FROM items WHERE id = $1 FOR UPDATE",
      [containerId],
    );
    const container = found[0];
    if (!container) throw notFound("That container no longer exists.");
    if (container.category === "Domain") throw badRequest("A domain cannot hold physical contents.");

    if (clean.containerName && clean.containerName !== container.name) {
      await client.query("UPDATE items SET name = $2, updated_at = now() WHERE id = $1", [containerId, clean.containerName]);
      renamed = { from: container.name, to: clean.containerName };
    }

    const locationId = input.inheritLocation === false ? null : container.location_id;
    const lines: ContentLine[] = [];
    for (const line of clean.lines) {
      let itemId: string | null = null;
      if (line.create) {
        // Direct insert rather than items.createItem: that starts a web lookup
        // per item in the background, which forty lines from one box should not,
        // and cannot share this transaction. With no asset code given, the
        // database trigger picks an unused one.
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO items (name, description, category, parent_item_id, location_id, quantity,
                              enrichment_source, metadata, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'container-capture', $7, $8) RETURNING id`,
          [
            line.name,
            line.description,
            line.category,
            containerId,
            locationId,
            line.qty,
            JSON.stringify({ packedIn: containerId }),
            userOid,
          ],
        );
        itemId = rows[0]!.id;
        created.push({ id: itemId, name: line.name });
        if (line.condition || line.fragile) {
          reportIds.push(
            await insertReport(
              client,
              {
                itemId,
                stage: "before",
                rating: line.condition,
                notes: "Recorded when packed.",
                handlingNote: line.fragile ? FRAGILE_NOTE : null,
                attachmentIds: [],
                aiAssisted: Boolean(input.aiAssisted),
              },
              userOid,
            ),
          );
        }
      }
      const { create: _create, ...stored } = line;
      lines.push({ ...stored, itemId });
    }

    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO container_captures
         (item_id, size_class, handwritten_text, room, contents_summary, contents, flags, confidence,
          ai_assisted, attachment_ids, created_item_ids, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        containerId,
        clean.sizeClass,
        clean.handwrittenText,
        clean.room,
        clean.contentsSummary,
        JSON.stringify(lines),
        clean.flags,
        input.confidence ? JSON.stringify(input.confidence) : null,
        Boolean(input.aiAssisted),
        attachmentIds,
        created.map((c) => c.id),
        userOid,
      ],
    );
    captureId = inserted[0]!.id;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // After the commit: history and webhooks describe what really happened.
  for (const c of created) {
    await recordEvent(c.id, userOid, "created", { name: c.name, source: "container-capture", containerId });
  }
  if (renamed) {
    await recordEvent(containerId, userOid, "updated", { fields: ["name"], source: "container-capture" });
  }
  for (const id of reportIds) {
    const report = await getReport(id);
    if (report) await publishReportCreated(report, userOid);
  }
  const capture = (await getCapture(captureId))!;
  logger.info("ai_condition.container.captured", {
    containerId,
    captureId,
    lines: capture.contents.length,
    created: created.length,
    aiAssisted: capture.aiAssisted,
  });
  await publish(
    "container.captured",
    {
      captureId,
      containerId,
      sizeClass: capture.sizeClass,
      room: capture.room,
      flags: capture.flags,
      contentsSummary: capture.contentsSummary,
      lines: capture.contents.length,
      createdItemIds: capture.createdItemIds,
      aiAssisted: capture.aiAssisted,
    },
    { actor: actorFromOid(userOid), subject: { type: "item", id: containerId } },
  );
  return { capture, createdItemIds: capture.createdItemIds, reportIds };
}
