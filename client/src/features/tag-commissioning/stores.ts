import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { tagsApi } from "./api";
import type { ItemTags, PaletteColor, TagSettings, TagSummary } from "./types";

/**
 * Client-side caches for tag data. Lists render many cards at once, so their
 * summaries are batched into one request; the item page and each unit card
 * read the same item's tags, so that is fetched once and shared.
 */

// ---- Settings (palette, EPC scheme) ---------------------------------------

let settings: TagSettings | null = null;
let settingsLoad: Promise<TagSettings> | null = null;
const settingsListeners = new Set<() => void>();

function loadSettings(): Promise<TagSettings> {
  settingsLoad ??= tagsApi.settings().then((s) => {
    settings = s;
    for (const l of settingsListeners) l();
    return s;
  });
  return settingsLoad;
}

export function setTagSettings(next: TagSettings): void {
  settings = next;
  settingsLoad = Promise.resolve(next);
  for (const l of settingsListeners) l();
}

export function useTagSettings(): TagSettings | null {
  const value = useSyncExternalStore(
    (l) => {
      settingsListeners.add(l);
      return () => settingsListeners.delete(l);
    },
    () => settings,
    () => settings,
  );
  useEffect(() => {
    if (!settings) void loadSettings().catch(() => undefined);
  }, []);
  return value;
}

/** Hex for a sticker colour; grey when the colour has left the palette. */
export function colorHex(palette: PaletteColor[] | undefined, name: string): string {
  return palette?.find((c) => c.name === name.toUpperCase())?.hex ?? "#64748b";
}

// ---- Batched summaries for lists ------------------------------------------

const summaries = new Map<string, TagSummary | null>();
const summaryListeners = new Set<() => void>();
let queued = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let summaryVersion = 0;

function flush(): void {
  timer = null;
  const ids = [...queued];
  queued = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    tagsApi
      .summary(chunk)
      .then((result) => {
        for (const id of chunk) summaries.set(id, result[id] ?? null);
      })
      .catch(() => {
        // Leave them unknown; a card without a chip is still a card.
        for (const id of chunk) summaries.set(id, null);
      })
      .finally(() => {
        summaryVersion += 1;
        for (const l of summaryListeners) l();
      });
  }
}

function requestSummary(id: string): void {
  if (summaries.has(id) || queued.has(id)) return;
  queued.add(id);
  // Every card on the page mounts in the same tick; wait for all of them.
  timer ??= setTimeout(flush, 30);
}

/** Forget cached summaries after a change, so cards pick up the new tier. */
export function invalidateSummaries(itemId?: string): void {
  if (itemId) summaries.delete(itemId);
  else summaries.clear();
  summaryVersion += 1;
  for (const l of summaryListeners) l();
}

export function useTagSummary(itemId: string): TagSummary | null {
  useSyncExternalStore(
    (l) => {
      summaryListeners.add(l);
      return () => summaryListeners.delete(l);
    },
    () => summaryVersion,
    () => summaryVersion,
  );
  useEffect(() => {
    requestSummary(itemId);
  });
  return summaries.get(itemId) ?? null;
}

// ---- One item's tags, shared by the item page and its unit cards ----------

const itemTags = new Map<string, ItemTags>();
const itemLoads = new Map<string, Promise<ItemTags>>();
const itemListeners = new Set<() => void>();
let itemVersion = 0;

function fetchItemTags(itemId: string): Promise<ItemTags> {
  let load = itemLoads.get(itemId);
  if (!load) {
    load = tagsApi.itemTags(itemId).then((t) => {
      itemTags.set(itemId, t);
      itemVersion += 1;
      for (const l of itemListeners) l();
      return t;
    });
    load.finally(() => itemLoads.delete(itemId)).catch(() => undefined);
    itemLoads.set(itemId, load);
  }
  return load;
}

/**
 * The item's tags, fetched when first needed and again whenever `key`
 * changes (pass something that changes when the item's identifiers do).
 */
export function useItemTags(itemId: string, key: string) {
  useSyncExternalStore(
    (l) => {
      itemListeners.add(l);
      return () => itemListeners.delete(l);
    },
    () => itemVersion,
    () => itemVersion,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchItemTags(itemId).catch((err) =>
      setError(err instanceof Error ? err.message : "Could not load tags"),
    );
  }, [itemId, key]);
  const reload = useCallback(async () => {
    invalidateSummaries(itemId);
    return fetchItemTags(itemId);
  }, [itemId]);
  return { data: itemTags.get(itemId) ?? null, error, reload };
}
