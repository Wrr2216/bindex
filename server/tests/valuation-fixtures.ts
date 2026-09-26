/**
 * Replies a vision model gave (or plausibly gives) for receipts and item
 * photos, used by the valuation tests and served by the AI stub when smoke
 * testing: `startAiStub({ chat: () => chatReply(JSON.stringify(RECEIPT_ELECTRONICS)) })`.
 */

/** A clean US electronics receipt: serials on lines, a protection plan, tax. */
export const RECEIPT_ELECTRONICS = {
  vendor: "Micro Center #041",
  date: "03/02/2024",
  currency: "USD",
  lines: [
    { description: "DELL LAT 5440 I7 16GB 512GB", qty: 1, unitPrice: 1299.99, total: 1299.99, sku: "LAT5440-7XK", serial: "S/N: 7XK2P93", warrantyMonths: null },
    { description: "DELL P2723DE 27IN MONITOR", qty: 2, unitPrice: "$329.00", total: "$658.00", sku: "P2723DE", serial: null },
    { description: "USB-C CABLE 2M", qty: 1, unitPrice: 12.99, total: 12.99, sku: null, serial: null },
    { description: "2YR PROTECTION PLAN LAPTOP", qty: 1, unitPrice: 149, total: 149, sku: "PP2Y", serial: null, warrantyMonths: 24 },
  ],
  subtotal: 2119.98,
  tax: 174.9,
  total: 2294.88,
  rawText: "MICRO CENTER #041\n03/02/2024 14:31\nDELL LAT 5440 I7 16GB 512GB 1299.99\nS/N: 7XK2P93\n...",
};

/** A European till receipt: decimal commas, day-first date, quantities as "x2", odd key names. */
export const RECEIPT_EUROPEAN = {
  store: "Bürohaus Müller GmbH",
  purchase_date: "03.02.2024",
  currency: "€",
  items: [
    { name: "Bürostuhl ErgoPro", quantity: "x2", unit_price: "189,50 €", line_total: "379,00" },
    { name: "Rabatt", quantity: 1, total: "-20,00" },
  ],
  subtotal: "359,00",
  vat: "68,21",
  grand_total: "427,21 €",
};

/** A reply whose lines do not add up to the printed subtotal, and whose date is not a date. */
export const RECEIPT_MISREAD = {
  vendor: "Hardware Depot",
  date: "32/13/2024",
  lines: [
    { description: "PALLET JACK 5500LB", qty: 1, unitPrice: 449, total: 449 },
    { description: "WHEEL KIT", qty: 2, unitPrice: 25, total: 60 },
  ],
  subtotal: 600,
  tax: 30,
  total: 700,
};

/** What a model says for a photo with no receipt in it. */
export const RECEIPT_NONE = { vendor: null, date: null, lines: [], subtotal: null, tax: null, total: null, rawText: "" };

/** A well-behaved valuation of a photographed item. */
export const VALUATION_GOOD = {
  brand: "Herman Miller",
  model: "Aeron Size B",
  category: "Office chair",
  materials: ["aluminium", "pellicle mesh"],
  condition: "Very good",
  conditionNotes: "Light scuffs on the base; mesh intact.",
  description: "Black Herman Miller Aeron office chair, size B, fully adjustable arms, polished aluminium base.",
  estimatedValue: { low: 550, high: 750, currency: "USD", basis: "Used resale price for a size B Aeron in good condition." },
  confidence: 0.82,
};

/** An unidentified object with a range too wide to mean anything, as a string. */
export const VALUATION_VAGUE = {
  brand: "unknown",
  model: null,
  description: "A grey metal box with a handle.",
  estimatedValue: "$20 - $400",
  confidence: "high",
};
