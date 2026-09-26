/**
 * Vision replies for bulk-capture tests, shaped like what real providers send:
 * mixed confidence forms, a 0–1000 box grid in one reply, counts as strings.
 *
 * Three overlapping photos of one conference room, left to right. The same
 * chairs, table and phone appear in more than one; a "TV" and a "television"
 * are the same set called two things (too different to merge on their own);
 * a red chair is a different chair from the black ones.
 */

export const ROOM_PHOTO_1 = {
  room: "Conference room",
  items: [
    { name: "office chair", category: "seating", qty: 4, bbox: [0.05, 0.4, 0.5, 0.5], confidence: 0.92 },
    { name: "conference table", category: "table", qty: 1, bbox: [0.2, 0.45, 0.7, 0.4], confidence: 0.95 },
    { name: "whiteboard", category: "fixture", qty: 1, bbox: [0.0, 0.1, 0.3, 0.3], confidence: "high" },
    { name: "monitor", category: "monitor", brand: "Dell", qty: 1, bbox: null, confidence: 0.7 },
  ],
};

export const ROOM_PHOTO_2 = {
  room: "Conference room with a wall-mounted screen",
  items: [
    // The 0–1000 grid some model families use.
    { name: "black office chair", category: "seating", qty: "6", bbox: [100, 420, 800, 500], confidence: 0.9 },
    { name: "conference table", category: "table", qty: 1, bbox: [150, 450, 700, 400], confidence: "0.93" },
    { name: "TV", category: "av", brand: "Samsung", qty: 1, bbox: [300, 80, 400, 250], confidence: 0.88 },
    { name: "conference phone", category: "phone", brand: "Poly", qty: 1, bbox: [480, 520, 60, 40], confidence: 0.6 },
  ],
};

export const ROOM_PHOTO_3 = {
  room: null,
  items: [
    { name: "office chair", category: "seating", qty: "x3", bbox: [0.3, 0.45, 0.6, 0.5], confidence: 0.85 },
    { name: "red office chair", category: "seating", qty: 1, bbox: [0.8, 0.5, 0.15, 0.3], confidence: 0.8 },
    { name: "television", category: "av", brand: "Samsung", qty: 1, bbox: [0.05, 0.1, 0.3, 0.2], confidence: 0.75 },
    { name: "Poly Trio conference phone", category: "phone", brand: "Poly", qty: 1, confidence: "medium" },
    { name: "floor lamp", category: "lighting", qty: 1, bbox: [0.9, 0.2, 0.08, 0.6], confidence: 0.7 },
  ],
};

export const ROOM_PHOTOS = [ROOM_PHOTO_1, ROOM_PHOTO_2, ROOM_PHOTO_3];

/** A handwritten coloured-lot inventory page. */
export const MANIFEST_PAGE_1 = {
  header: { title: "Descriptive inventory", date: "09/22/2026", lot: "2231", stickerColor: "Red", reference: "Job 4471" },
  rows: [
    { lineNo: "1", description: "Sofa, 3 seat", qty: 1, conditionCodes: ["SC-3,7", "SO"], sticker: { number: "001" }, room: "Lobby", confidence: 0.8 },
    { lineNo: 2, description: "Carton, books", qty: "4 ea", conditionCodes: "CP", sticker: "002", room: "Office 2", confidence: 0.9 },
    { lineNo: "3.", description: "Desk, oak", qty: 1, conditionCodes: ["BR 6", "scratched"], sticker: { number: "003" }, room: "Office 2", confidence: 0.55 },
    { lineNo: 4, description: "Carton, books", qty: 2, conditionCodes: [], sticker: { number: "004" }, room: "Office 3", confidence: 0.9 },
    { lineNo: null, description: "", qty: 1 },
  ],
};

/** The same page photographed again, overlapping lines 3 and 4, then line 5. */
export const MANIFEST_PAGE_1_AGAIN = {
  header: { lot: "2231", stickerColor: "red" },
  rows: [
    { lineNo: 3, description: "Desk oak", qty: 1, conditionCodes: ["BR-6"], sticker: { number: "003" }, room: "Office 2", confidence: 0.7 },
    { lineNo: 4, description: "Carton books", qty: 2, sticker: { number: "004" }, room: "Office 3", confidence: 0.85 },
    { lineNo: 5, description: "Filing cabinet, 4 drawer", qty: 1, conditionCodes: ["D-4"], sticker: { color: "Blue", lot: "2231", number: "005" }, room: "Office 3", confidence: 0.9 },
  ],
};

/** One desk of a desk survey: a monitor short and no dock. */
export const DESK_PHOTO = {
  deskLabel: "4B-12",
  items: [
    { name: "monitor", category: "monitor", brand: "Dell", qty: 1, confidence: 0.9 },
    { name: "monitor arm", category: "peripheral", qty: 1, confidence: 0.8 },
    { name: "task chair", category: "seating", qty: 1, confidence: 0.9 },
    { name: "mobile pedestal", category: "storage", qty: 1, confidence: 0.85 },
    { name: "keyboard", category: "peripheral", qty: 1, confidence: 0.9 },
  ],
};
