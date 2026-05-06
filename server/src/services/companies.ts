import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { companies } from "../db/schema";
import { notFound } from "../lib/errors";

export type CompanyInput = { name: string; notes?: string | null };

export const listCompanies = () => db.select().from(companies).orderBy(companies.name);

export async function createCompany(input: CompanyInput) {
  const [row] = await db.insert(companies).values(input).returning();
  return row!;
}

export async function updateCompany(id: string, patch: Partial<CompanyInput>) {
  const [row] = await db.update(companies).set(patch).where(eq(companies.id, id)).returning();
  if (!row) throw notFound("Company not found");
  return row;
}

export async function deleteCompany(id: string) {
  const deleted = await db.delete(companies).where(eq(companies.id, id)).returning({ id: companies.id });
  if (!deleted.length) throw notFound("Company not found");
}
