import type { CaptureDeskTemplate } from "../../db/tables/bulk-capture";
import { categoryKey, nameKey, nameTokens } from "./names";

/**
 * Desk-level surveys: every workstation is expected to carry a standard kit,
 * and the survey flags what is missing at each desk. Pure.
 */

export const DEFAULT_DESK_TEMPLATE: CaptureDeskTemplate = {
  id: "standard",
  name: "Standard workstation",
  items: [
    { key: "monitor", label: "Monitor", qty: 2, match: ["monitor", "display", "screen"] },
    { key: "dock", label: "Docking station", qty: 1, match: ["dock", "docking station", "port replicator"] },
    { key: "chair", label: "Chair", qty: 1, match: ["chair", "seat", "stool"] },
    { key: "pedestal", label: "Pedestal", qty: 1, match: ["pedestal", "drawer unit", "mobile drawer", "filing cabinet", "file cabinet"] },
  ],
};

export type DeskDraft = { name: string; category: string | null; qty: number; area: string | null; status: string };

export type DeskLine = { key: string; label: string; expected: number; found: number; missing: number; extra: number };

export type DeskCheck = {
  desk: string;
  lines: DeskLine[];
  /** Things at the desk that the template does not mention. */
  others: { name: string; qty: number }[];
  complete: boolean;
};

/** Which template line a draft counts towards, or null. First match wins. */
export function templateLineFor(draft: { name: string; category: string | null }, template: CaptureDeskTemplate): string | null {
  const phrase = ` ${nameTokens(draft.name).join(" ")} `;
  const tokens = nameTokens(draft.name);
  const head = tokens[tokens.length - 1] ?? "";
  // The head noun decides first, so a "monitor arm" is not a monitor.
  for (const line of template.items) {
    if (line.match.some((m) => nameKey(m) === head)) return line.key;
  }
  for (const line of template.items) {
    if (line.match.some((m) => nameKey(m).includes(" ") && phrase.includes(` ${nameKey(m)} `))) return line.key;
  }
  // A name with no telling noun ("LG UltraFine 27") still counts when its
  // category is the line itself. Broader categories are not enough: a keyboard
  // and a dock are both peripherals.
  const cat = categoryKey(draft.category, null);
  if (cat !== "other") return template.items.find((line) => line.key === cat)?.key ?? null;
  return null;
}

const deskName = (area: string | null) => area?.trim() || "Unlabelled desk";

/**
 * Compare each desk with the template. `desks` lists every desk that has
 * photos, so a desk where nothing at all was recognised still shows up as
 * missing everything. Deleted entries do not count.
 */
export function checkDesks(drafts: DeskDraft[], template: CaptureDeskTemplate, desks: (string | null)[]): DeskCheck[] {
  const order: string[] = [];
  const byDesk = new Map<string, DeskDraft[]>();
  const add = (name: string) => {
    const key = name.toLowerCase();
    if (!byDesk.has(key)) {
      byDesk.set(key, []);
      order.push(name);
    }
    return byDesk.get(key)!;
  };
  for (const d of desks) add(deskName(d));
  for (const d of drafts) {
    if (d.status === "discarded") continue;
    add(deskName(d.area)).push(d);
  }

  return order.map((desk) => {
    const found = new Map<string, number>();
    const others: { name: string; qty: number }[] = [];
    for (const d of byDesk.get(desk.toLowerCase())!) {
      const line = templateLineFor(d, template);
      if (line) found.set(line, (found.get(line) ?? 0) + d.qty);
      else others.push({ name: d.name, qty: d.qty });
    }
    const lines = template.items.map((t) => {
      const f = found.get(t.key) ?? 0;
      return { key: t.key, label: t.label, expected: t.qty, found: f, missing: Math.max(0, t.qty - f), extra: Math.max(0, f - t.qty) };
    });
    return { desk, lines, others, complete: lines.every((l) => l.missing === 0) };
  });
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A template from settings or a request, cleaned; null when it has nothing usable. */
export function normalizeTemplate(v: unknown): CaptureDeskTemplate | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
  const idRaw = typeof o.id === "string" ? o.id.trim().toLowerCase() : "";
  const id = KEY.test(idRaw) ? idRaw : nameKey(name).replace(/\s+/g, "-").slice(0, 40);
  if (!name || !id || !Array.isArray(o.items)) return null;
  const items: CaptureDeskTemplate["items"] = [];
  const seen = new Set<string>();
  for (const raw of o.items) {
    if (!raw || typeof raw !== "object") continue;
    const i = raw as Record<string, unknown>;
    const label = typeof i.label === "string" ? i.label.trim().slice(0, 60) : "";
    if (!label) continue;
    const keyRaw = typeof i.key === "string" ? i.key.trim().toLowerCase() : "";
    const key = KEY.test(keyRaw) ? keyRaw : nameKey(label).replace(/\s+/g, "-").slice(0, 40);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const qty = typeof i.qty === "number" && Number.isInteger(i.qty) ? Math.min(20, Math.max(1, i.qty)) : 1;
    const match = (Array.isArray(i.match) ? i.match : [])
      .filter((m): m is string => typeof m === "string" && Boolean(m.trim()))
      .map((m) => m.trim().toLowerCase().slice(0, 40))
      .slice(0, 12);
    items.push({ key, label, qty, match: match.length ? match : [label.toLowerCase()] });
    if (items.length >= 20) break;
  }
  return items.length ? { id, name, items } : null;
}
