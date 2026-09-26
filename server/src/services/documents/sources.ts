/**
 * Where a table block's rows come from. Each source names its columns (what
 * the editor offers and what validation accepts) and gives sample rows for
 * previews; the database loader is attached separately (context.ts), so this
 * file stays pure.
 *
 * Later features add their own, from their own module:
 *
 *   registerTableSource({ name: "claims", label: "Claims", columns: [...], sample: [...], load })
 */

export type TableColumn = { key: string; label: string };
export type TableCell = string | number | boolean | null;
export type TableRow = Record<string, TableCell>;
export type TableFilter = { floor?: string; department?: string; stage?: string };
export type TableData = { rows: TableRow[]; total: number };
export type TableLoader = (jobId: string, filter: TableFilter) => Promise<TableData>;

export type TableSource = {
  name: string;
  label: string;
  columns: TableColumn[];
  /** Columns a new table block starts with. */
  defaultColumns: string[];
  /** Which filters apply, so the editor only offers those. */
  filters: (keyof TableFilter)[];
  /** Rows for a preview without a job. */
  sample: TableRow[];
  load?: TableLoader;
};

/** Rows kept per table in a completed document's snapshot and printed. */
export const MAX_TABLE_ROWS = 5000;

const registry = new Map<string, TableSource>();

export function registerTableSource(source: TableSource): void {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(source.name)) {
    throw new Error(`Table source "${source.name}" must be lowercase letters, digits and underscores.`);
  }
  const existing = registry.get(source.name);
  registry.set(source.name, { ...existing, ...source, load: source.load ?? existing?.load });
}

/** Attach the database loader to a source declared here. */
export function setTableLoader(name: string, load: TableLoader): void {
  const source = registry.get(name);
  if (!source) throw new Error(`Unknown table source "${name}".`);
  source.load = load;
}

export const tableSource = (name: string): TableSource | undefined => registry.get(name);
export const tableSources = (): TableSource[] => [...registry.values()];

registerTableSource({
  name: "manifest",
  label: "Manifest",
  columns: [
    { key: "code", label: "Code" },
    { key: "item", label: "Item" },
    { key: "description", label: "Make and model" },
    { key: "serial", label: "Serial" },
    { key: "origin", label: "From" },
    { key: "destination", label: "To" },
    { key: "floor", label: "Floor" },
    { key: "department", label: "Department" },
    { key: "crate", label: "Crate" },
    { key: "stage", label: "Stage" },
    { key: "shipment", label: "Shipment" },
    { key: "notes", label: "Notes" },
  ],
  defaultColumns: ["code", "item", "origin", "destination", "stage"],
  filters: ["floor", "department", "stage"],
  sample: [
    { code: "INV-7F3K2A", item: "Laptop", description: "Dell Latitude 5440", serial: "7XK2P93", origin: "Floor 3 / Finance", destination: "Level 5 / 5.12", floor: "5", department: "Finance", crate: "C1", stage: "packed", shipment: "SHP-4Q2M9T", notes: null },
    { code: "INV-9QX3TR", item: "Monitor", description: "LG 27UL500", serial: "207NTAB1C123", origin: "Floor 3 / Finance", destination: "Level 5 / 5.12", floor: "5", department: "Finance", crate: "C1", stage: "loaded", shipment: "SHP-4Q2M9T", notes: "Fragile" },
    { code: "INV-2B8D0K", item: "Docking station", description: "Dell WD19S", serial: "CN0F6G8K", origin: "Floor 3 / Legal", destination: "Level 5 / 5.14", floor: "5", department: "Legal", crate: "C4", stage: "pending", shipment: null, notes: null },
  ],
});

registerTableSource({
  name: "tasks",
  label: "Tasks",
  columns: [
    { key: "title", label: "Task" },
    { key: "kind", label: "Kind" },
    { key: "status", label: "Status" },
    { key: "assignee", label: "Assignee" },
    { key: "due", label: "Due" },
    { key: "completed", label: "Completed" },
  ],
  defaultColumns: ["title", "status", "assignee", "completed"],
  filters: [],
  sample: [
    { title: "Pack workstations", kind: "pack", status: "done", assignee: "Crew 3", due: "2026-10-02T13:00:00.000Z", completed: "2026-10-02T15:30:00.000Z" },
    { title: "Load trucks", kind: "load", status: "doing", assignee: "Crew 3", due: "2026-10-03T13:00:00.000Z", completed: null },
    { title: "Place at destination", kind: "place", status: "todo", assignee: null, due: null, completed: null },
  ],
});

registerTableSource({
  name: "shipments",
  label: "Shipments",
  columns: [
    { key: "code", label: "Code" },
    { key: "name", label: "Name" },
    { key: "carrier", label: "Carrier" },
    { key: "status", label: "Status" },
    { key: "seals", label: "Seals" },
    { key: "eta", label: "ETA" },
    { key: "lines", label: "Lines" },
  ],
  defaultColumns: ["code", "name", "carrier", "status", "seals"],
  filters: [],
  sample: [
    { code: "SHP-4Q2M9T", name: "Truck 1", carrier: "Acme Freight", status: "loaded", seals: "SEAL-0041", eta: "2026-10-03T16:00:00.000Z", lines: 42 },
    { code: "SHP-8T1W3E", name: "Truck 2", carrier: "Acme Freight", status: "planned", seals: null, eta: null, lines: 17 },
  ],
});
