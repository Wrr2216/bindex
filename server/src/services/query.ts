import { and, desc, eq, gte, ilike, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { items, locations, companies, entities } from "../db/schema";
import { env } from "../env";
import { badRequest } from "../lib/errors";
import { logger } from "../lib/logger";
import { chatJson } from "./enrichment/model";
import { getConfig } from "./config";

/**
 * Search by describing what you are looking for instead of filling in fields:
 * "unassigned monitors over $200", "everything in the garage checked out to
 * Sam". The sentence is turned into a filter, the filter runs as ordinary SQL,
 * and the filter comes back with the results so it is obvious how the question
 * was read.
 *
 * Optional. Without LLM_API_KEY the endpoint reports that it is unavailable and
 * the client hides the control.
 */

export type QueryFilter = {
  text?: string;
  category?: string;
  status?: string;
  locationName?: string;
  groupName?: string;
  holderName?: string;
  minValue?: number;
  maxValue?: number;
  checkedOut?: boolean;
  noLocation?: boolean;
  noValue?: boolean;
};

/**
 * The vocabulary of the instance goes into the prompt, so a deployment that
 * calls groups "Households" can be asked about households.
 */
async function systemPrompt(): Promise<string> {
  const { terms } = await getConfig();
  return [
    "You translate a question about an inventory into a JSON filter.",
    "Reply with one JSON object in a ```json code block and nothing else.",
    "Every key is optional; omit the ones the question does not mention.",
    "Keys:",
    "- text: string, keywords matched against name, brand, model and category",
    "- category: string",
    '- status: string, such as "active" or "retired"',
    `- locationName: string, the ${terms.location.singular.toLowerCase()} holding the item`,
    `- groupName: string, the ${terms.group.singular.toLowerCase()} the item belongs to`,
    `- holderName: string, the ${terms.holder.singular.toLowerCase()} the item is out with`,
    "- minValue: number, minimum value in dollars",
    "- maxValue: number, maximum value in dollars",
    "- checkedOut: boolean, true when the item is currently out",
    "- noLocation: boolean, true for items with no location set",
    "- noValue: boolean, true for items with no value set",
    "Values are numbers, not strings. Never invent a value the question does not imply.",
  ].join("\n");
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

async function interpret(question: string): Promise<QueryFilter> {
  const parsed = await chatJson({
    event: "query.interpret",
    system: await systemPrompt(),
    user: `Question: ${question}`,
  });
  if (!parsed) return {};

  return {
    text: text(parsed.text),
    category: text(parsed.category),
    status: text(parsed.status),
    locationName: text(parsed.locationName),
    groupName: text(parsed.groupName),
    holderName: text(parsed.holderName),
    minValue: num(parsed.minValue),
    maxValue: num(parsed.maxValue),
    checkedOut: typeof parsed.checkedOut === "boolean" ? parsed.checkedOut : undefined,
    noLocation: parsed.noLocation === true || undefined,
    noValue: parsed.noValue === true || undefined,
  };
}

export async function askSearch(
  question: string,
  kind: "physical" | "digital" | "all" = "physical",
) {
  if (!env.llmConfigured) {
    throw badRequest("Search by question is not configured on this instance.");
  }
  const q = question.trim();
  if (!q) throw badRequest("Ask a question first.");

  const filter = await interpret(q);
  logger.info("query.interpreted", { q, filter, kind });

  const conds: SQL[] = [];
  if (kind === "physical") conds.push(sql`${items.category} IS DISTINCT FROM 'Domain'`);
  else if (kind === "digital") conds.push(eq(items.category, "Domain"));

  if (filter.text) {
    const like = `%${filter.text}%`;
    const match = or(
      ilike(items.name, like),
      ilike(items.brand, like),
      ilike(items.model, like),
      ilike(items.category, like),
    );
    if (match) conds.push(match);
  }
  if (filter.category) conds.push(ilike(items.category, `%${filter.category}%`));
  if (filter.status) conds.push(eq(items.status, filter.status));
  if (filter.locationName) conds.push(ilike(locations.name, `%${filter.locationName}%`));
  if (filter.groupName) conds.push(ilike(companies.name, `%${filter.groupName}%`));
  if (filter.holderName) conds.push(ilike(entities.name, `%${filter.holderName}%`));
  if (filter.minValue !== undefined) {
    conds.push(gte(items.valueCents, Math.round(filter.minValue * 100)));
  }
  if (filter.maxValue !== undefined) {
    conds.push(lte(items.valueCents, Math.round(filter.maxValue * 100)));
  }
  if (filter.checkedOut === true) conds.push(isNotNull(items.utilizedByEntityId));
  if (filter.checkedOut === false) conds.push(isNull(items.utilizedByEntityId));
  if (filter.noLocation) conds.push(isNull(items.locationId));
  if (filter.noValue) conds.push(isNull(items.valueCents));

  const rows = await db
    .select({
      item: items,
      locationName: locations.name,
      companyName: companies.name,
      utilizedByEntityName: entities.name,
    })
    .from(items)
    .leftJoin(locations, eq(items.locationId, locations.id))
    .leftJoin(companies, eq(locations.companyId, companies.id))
    .leftJoin(entities, eq(items.utilizedByEntityId, entities.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(items.updatedAt))
    .limit(100);

  return {
    filter,
    items: rows.map((r) => ({
      ...r.item,
      locationName: r.locationName,
      companyName: r.companyName,
      utilizedByEntityName: r.utilizedByEntityName,
    })),
  };
}
