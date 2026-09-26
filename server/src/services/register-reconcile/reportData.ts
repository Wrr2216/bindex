import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { registerImports, registerRows, type RegisterEdit } from "../../db/tables/register-reconcile";
import { getConfig } from "../config";
import { CLASS_ORDER } from "./classify";
import { getRun, listResults, type ResultView } from "./reconcile";
import type { ReportData, ReportLine } from "./report";

const FIELD_LABEL: Record<string, string> = {
  assetTag: "Asset tag",
  serial: "Serial",
  epc: "EPC",
  model: "Model",
  cost: "Cost",
  name: "Name",
  locationText: "Location",
  bindexCode: "Printed code",
};

const METHOD_LABEL: Record<string, string> = {
  asset_tag: "asset tag",
  serial: "serial",
  epc: "EPC",
  asset_code: "printed code",
};

/** Everything the XLSX and PDF reports print for one run. */
export async function buildReportData(runId: string): Promise<ReportData> {
  const [run, config] = await Promise.all([getRun(runId), getConfig()]);
  const [imp] = await db.select().from(registerImports).where(eq(registerImports.id, run.importId)).limit(1);
  const { results } = await listResults(runId, { status: "all", limit: 100_000 });
  const money = new Intl.NumberFormat(config.locale, { style: "currency", currency: config.currency });
  const fmt = (field: string, v: string | null) =>
    v == null ? "(empty)" : field === "cost" && /^-?\d+$/.test(v) ? money.format(Number(v) / 100) : v;

  const line = (r: ResultView): ReportLine => {
    const details: string[] = [];
    if (r.matchMethod) details.push(`Matched on ${METHOD_LABEL[r.matchMethod] ?? r.matchMethod}.`);
    for (const c of r.conflicts) {
      details.push(`${FIELD_LABEL[c.field] ?? c.field}: register ${fmt(c.field, c.register)}, here ${fmt(c.field, c.bindex)}.`);
    }
    if (r.proposal) {
      const who = [r.proposal.assetCode, r.proposal.name].filter(Boolean).join(" ");
      details.push(`Possible match: ${who} (similarity ${r.proposal.score.toFixed(2)}).`);
    }
    details.push(...r.notes);
    const status =
      r.resolution === "resolved"
        ? `Resolved${r.resolutionNote ? `: ${r.resolutionNote}` : ""}`
        : r.resolution === "ignored"
          ? `Ignored${r.resolutionNote ? `: ${r.resolutionNote}` : ""}`
          : r.classes.length === 1 && r.classes[0] === "matched"
            ? ""
            : "Open";
    return {
      rowNumber: r.row?.rowNumber ?? null,
      assetTag: r.row?.assetTag ?? null,
      serial: r.row?.serial ?? null,
      registerName: r.row ? (r.row.name ?? r.row.model) : null,
      registerLocation: r.row?.locationText ?? null,
      assetCode: r.asset?.assetCode ?? null,
      itemName: r.asset ? `${r.asset.name ?? ""}${r.asset.exists ? "" : " (deleted)"}` : null,
      location: r.asset ? (r.asset.locationAtRun?.path ?? r.asset.location?.path ?? null) : null,
      details: details.join(" "),
      status,
    };
  };

  const edited = await db
    .select({ rowNumber: registerRows.rowNumber, assetTag: registerRows.assetTag, edits: registerRows.edits })
    .from(registerRows)
    .where(and(eq(registerRows.importId, run.importId), sql`${registerRows.edits} <> '{}'::jsonb`))
    .orderBy(asc(registerRows.rowNumber));
  const registerEdits = edited.flatMap((r) =>
    Object.entries(r.edits as Record<string, RegisterEdit>).map(([field, e]) => ({
      rowNumber: r.rowNumber,
      assetTag: r.assetTag,
      field: FIELD_LABEL[field] ?? field,
      from: e.from == null ? null : fmt(field, e.from),
      to: e.to == null ? null : fmt(field, e.to),
    })),
  );

  return {
    appName: config.appName,
    itemTerm: config.terms.item.singular,
    locationTerm: config.terms.location.singular,
    importName: run.importName,
    fileName: imp?.fileName ?? null,
    runAt: run.createdAt,
    scopeLabel: run.scopeLabel ?? "Everything",
    rowCount: run.importRowCount,
    counts: run.status,
    sections: CLASS_ORDER.map((cls) => ({ cls, lines: results.filter((r) => r.classes.includes(cls)).map(line) })),
    registerEdits,
  };
}
