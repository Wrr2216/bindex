import { pool } from "../../db/client";
import { env } from "../../env";
import { badRequest, notFound } from "../../lib/errors";
import { visionJson } from "../ai";
import {
  normalizeAssessment,
  normalizeComparison,
  normalizeContainerCapture,
  type AssessmentDraft,
  type ComparisonDraft,
  type ContainerDraft,
} from "./normalize";
import { assertPhotosOf, visionImages } from "./photos";
import { ASSESS_SYSTEM, COMPARE_SYSTEM, CONTAINER_SYSTEM, assessPrompt, comparePrompt, containerPrompt } from "./prompts";
import { getReport, type ConditionReport } from "./reports";
import { getConditionSettings } from "./settings";

/**
 * The three AI helpers. Each reads photos already attached to the record,
 * asks the vision model, and returns a draft for a person to confirm. None of
 * them writes anything. With no vision model configured they answer
 * { available: false } and the screens hide their buttons.
 */

export type AiResult<T> = { available: boolean; draft: T | null };

export const MAX_CONTAINER_PHOTOS = 4;
export const MAX_ASSESS_PHOTOS = 6;
export const MAX_COMPARE_PHOTOS = 4;

async function itemName(itemId: string): Promise<string> {
  const { rows } = await pool.query<{ name: string }>("SELECT name FROM items WHERE id = $1", [itemId]);
  if (!rows[0]) throw notFound("That item no longer exists.");
  return rows[0].name;
}

/** Read a container's photos: size class, writing, contents, marks. */
export async function readContainer(
  containerId: string,
  attachmentIds: string[],
  context: Record<string, unknown> = {},
): Promise<AiResult<ContainerDraft>> {
  await itemName(containerId);
  if (!env.llmVisionConfigured) return { available: false, draft: null };
  if (!attachmentIds.length) throw badRequest("Take at least one photo of the container first.");
  const ids = await assertPhotosOf(containerId, attachmentIds, MAX_CONTAINER_PHOTOS);
  const settings = await getConditionSettings();
  const images = await visionImages(ids);
  if (!images.length) return { available: true, draft: null };
  const raw = await visionJson({
    event: "ai_condition.container",
    system: CONTAINER_SYSTEM,
    prompt: containerPrompt({ sizeClasses: settings.sizeClasses, categories: settings.categories, hint: settings.promptHint }),
    images,
    maxTokens: 2000,
    context: { containerId, photos: images.length, ...context },
  });
  return { available: true, draft: normalizeContainerCapture(raw, settings) };
}

/** Assess an item's condition from its photos. */
export async function assessCondition(
  input: { itemId: string; attachmentIds: string[] },
  context: Record<string, unknown> = {},
): Promise<AiResult<AssessmentDraft>> {
  const name = await itemName(input.itemId);
  if (!env.llmVisionConfigured) return { available: false, draft: null };
  if (!input.attachmentIds.length) throw badRequest("Take at least one photo first.");
  const ids = await assertPhotosOf(input.itemId, input.attachmentIds, MAX_ASSESS_PHOTOS);
  const settings = await getConditionSettings();
  const images = await visionImages(ids);
  if (!images.length) return { available: true, draft: null };
  const raw = await visionJson({
    event: "ai_condition.assess",
    system: ASSESS_SYSTEM,
    prompt: assessPrompt({ itemName: name, hint: settings.promptHint }),
    images,
    maxTokens: 1200,
    context: { itemId: input.itemId, photos: images.length, ...context },
  });
  return { available: true, draft: normalizeAssessment(raw) };
}

const label = (r: ConditionReport) =>
  `${r.stageLabel ?? r.stage}, ${r.createdAt.toISOString().slice(0, 10)}`;

/**
 * Compare the photos of two reports of the same item. The photos are sent in
 * two runs, before then after, and the prompt says how many are in each.
 */
export async function compareReportsWithAi(
  beforeId: string,
  afterId: string,
  context: Record<string, unknown> = {},
): Promise<AiResult<ComparisonDraft> & { before: ConditionReport; after: ConditionReport }> {
  const [before, after] = await Promise.all([getReport(beforeId), getReport(afterId)]);
  if (!before || !after) throw notFound("One of those condition reports no longer exists.");
  if (before.itemId !== after.itemId) throw badRequest("Compare two reports of the same item.");
  if (!env.llmVisionConfigured) return { available: false, draft: null, before, after };
  const beforeIds = before.photos.slice(0, MAX_COMPARE_PHOTOS).map((p) => p.id);
  const afterIds = after.photos.slice(0, MAX_COMPARE_PHOTOS).map((p) => p.id);
  if (!beforeIds.length || !afterIds.length) {
    throw badRequest("Both reports need photos to compare them. Add photos to the one without.");
  }
  const settings = await getConditionSettings();
  const [b, a] = await Promise.all([visionImages(beforeIds), visionImages(afterIds)]);
  if (!b.length || !a.length) return { available: true, draft: null, before, after };
  const raw = await visionJson({
    event: "ai_condition.compare",
    system: COMPARE_SYSTEM,
    prompt: comparePrompt({
      beforeCount: b.length,
      afterCount: a.length,
      beforeLabel: label(before),
      afterLabel: label(after),
      beforeDefects: before.defects,
      beforeRating: before.rating,
      itemName: before.itemName,
      hint: settings.promptHint,
    }),
    images: [...b, ...a],
    maxTokens: 1500,
    context: { itemId: before.itemId, beforeId, afterId, ...context },
  });
  return { available: true, draft: normalizeComparison(raw), before, after };
}
