import { req } from "../../api/client";
import type { FieldNote, Snapshot } from "./types";

/** The offline field endpoints. These go through the offline transport like any other request. */
export const offlineApi = {
  snapshot: (locationId: string | null) =>
    req<Snapshot>(
      `/api/offline/snapshot${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ""}`,
    ),
  listNotes: (itemId: string) =>
    req<{ notes: FieldNote[] }>(`/api/offline/items/${itemId}/notes`).then((r) => r.notes),
  addNote: (itemId: string, text: string, unitId: string | null = null) =>
    req<FieldNote>(`/api/offline/items/${itemId}/notes`, {
      method: "POST",
      body: JSON.stringify({ text, unitId, writtenAt: new Date().toISOString() }),
    }),
};
