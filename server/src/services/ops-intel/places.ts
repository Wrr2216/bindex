/**
 * The location tree, as the rules and analytics need it: which place is
 * inside which, full paths for titles, and coordinates inherited from the
 * nearest place that has them. Pure; the caller loads the rows.
 */

export type Place = { id: string; parentId: string | null; name: string };
export type Coords = { lat: number; lng: number };

// Deep enough for any real building; also stops a parent loop from spinning.
const MAX_DEPTH = 64;

export class PlaceIndex {
  private readonly byId: Map<string, Place>;
  private readonly coords: Map<string, Coords>;

  constructor(places: Iterable<Place>, coords: Iterable<[string, Coords]> = []) {
    this.byId = new Map([...places].map((p) => [p.id, p]));
    this.coords = new Map(coords);
  }

  has(id: string | null | undefined): boolean {
    return !!id && this.byId.has(id);
  }

  name(id: string | null | undefined): string | null {
    return id ? (this.byId.get(id)?.name ?? null) : null;
  }

  /** Self first, then each parent up to the root. */
  lineage(id: string | null | undefined): string[] {
    const out: string[] = [];
    let cur = id ? this.byId.get(id) : undefined;
    while (cur && out.length < MAX_DEPTH && !out.includes(cur.id)) {
      out.push(cur.id);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return out;
  }

  /** "Warehouse / Aisle 3 / Bay 2". */
  path(id: string | null | undefined): string | null {
    const ids = this.lineage(id);
    if (!ids.length) return null;
    return ids
      .reverse()
      .map((x) => this.byId.get(x)!.name)
      .join(" / ");
  }

  /** True when `inner` is `outer` or anywhere beneath it. */
  within(inner: string | null | undefined, outer: string | null | undefined): boolean {
    if (!inner || !outer) return false;
    return this.lineage(inner).includes(outer);
  }

  /** True when either place contains the other: a reader zone and a shelf inside it agree. */
  related(a: string | null | undefined, b: string | null | undefined): boolean {
    return this.within(a, b) || this.within(b, a);
  }

  /** Coordinates of the place, or of the nearest place above it that has some. */
  coordsOf(id: string | null | undefined): Coords | null {
    for (const x of this.lineage(id)) {
      const c = this.coords.get(x);
      if (c) return c;
    }
    return null;
  }
}
