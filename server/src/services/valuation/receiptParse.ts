import { cleanText, parseCurrency, parseDate, parseMoney, parseQuantity } from "./parse";

/**
 * Reading receipts: the prompt, and the pure normalization of what the model
 * returns into lines a person can check and match to items.
 */

export type ReceiptLineReading = {
  description: string;
  quantity: number;
  unitPriceCents: number | null;
  totalCents: number | null;
  sku: string | null;
  serial: string | null;
  warrantyMonths: number | null;
};

export type ReceiptReading = {
  vendor: string | null;
  /** YYYY-MM-DD, or null when no date could be read as a real one. */
  purchaseDate: string | null;
  /** The date exactly as printed, so a person can check an ambiguous one. */
  datePrinted: string | null;
  currency: string;
  lines: ReceiptLineReading[];
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  /** Arithmetic that does not add up, in words, for the review screen. */
  warnings: string[];
  rawText: string;
};

export const RECEIPT_SYSTEM =
  "You read receipts and invoices from photos. You copy what is printed and never guess a value that is not visible. " +
  "Reply with one JSON object and nothing else.";

export const RECEIPT_PROMPT = `Read the receipt or invoice and reply with this JSON object:
{
  "vendor": the store or company that sold the goods, or null,
  "date": the purchase or invoice date exactly as printed, or null,
  "currency": the ISO 4217 code if printed or obvious from the symbol, or null,
  "lines": [{
    "description": the line as printed,
    "qty": quantity as a number (1 if not printed),
    "unitPrice": price of one as a number, or null,
    "total": the line total as a number, or null,
    "sku": product code, SKU, UPC or model number printed on the line, or null,
    "serial": serial number printed on or under the line, or null,
    "warrantyMonths": months of warranty or protection plan stated for this line, or null
  }],
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "rawText": all the text on the receipt, line by line
}
Amounts are plain numbers in major units (dollars, not cents) without symbols. A discount is a negative amount. Leave out payment, change, card and loyalty lines, but keep fees, delivery and protection plans as lines of their own. If there is no receipt in the image, set lines to [] and everything else to null.`;

const MAX_LINES = 200;
// Half a unit of slack on sums, for per-line rounding on the printed receipt.
const TOLERANCE_CENTS = 50;

function readLine(raw: unknown): ReceiptLineReading | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const description = cleanText(r.description ?? r.name ?? r.item ?? r.text, 300);
  if (!description) return null;
  const quantity = parseQuantity(r.qty ?? r.quantity) ?? 1;
  let unitPriceCents = parseMoney(r.unitPrice ?? r.unit_price ?? r.price, { allowNegative: true });
  let totalCents = parseMoney(r.total ?? r.amount ?? r.lineTotal ?? r.line_total, { allowNegative: true });
  // Fill whichever of the two was left out from the other.
  if (totalCents === null && unitPriceCents !== null) totalCents = Math.round(unitPriceCents * quantity);
  if (unitPriceCents === null && totalCents !== null) unitPriceCents = Math.round(totalCents / quantity);
  const months = parseQuantity(r.warrantyMonths ?? r.warranty_months);
  return {
    description,
    quantity,
    unitPriceCents,
    totalCents,
    sku: cleanText(r.sku ?? r.upc ?? r.code ?? r.model, 80),
    serial: cleanText(r.serial ?? r.serialNumber ?? r.serial_number, 80)?.replace(/^(?:s\/n|sn|serial(?: no)?)\s*[:#.]?\s*/i, "") || null,
    warrantyMonths: months && months <= 240 ? Math.round(months) : null,
  };
}

const money = (cents: number) => (cents / 100).toFixed(2);

/**
 * Turn whatever the model sent into a clean reading, or null when it sent
 * nothing that looks like a receipt. Pure, so each odd reply is a test case.
 *
 * `locale` decides how an all-numeric date such as 03/02/2024 is read.
 */
export function normalizeReceipt(
  raw: Record<string, unknown> | null,
  opts: { locale?: string; currency: string; now?: Date },
): ReceiptReading | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawLines = Array.isArray(raw.lines) ? raw.lines : Array.isArray(raw.items) ? raw.items : [];
  const lines = rawLines.slice(0, MAX_LINES).map(readLine).filter((l): l is ReceiptLineReading => l !== null);

  const datePrinted = cleanText(raw.date ?? raw.purchaseDate ?? raw.purchase_date, 60);
  const reading: ReceiptReading = {
    vendor: cleanText(raw.vendor ?? raw.store ?? raw.merchant ?? raw.seller, 120),
    purchaseDate: parseDate(datePrinted, opts.locale, opts.now),
    datePrinted,
    currency: parseCurrency(raw.currency, opts.currency) ?? opts.currency,
    lines,
    subtotalCents: parseMoney(raw.subtotal ?? raw.sub_total),
    taxCents: parseMoney(raw.tax ?? raw.vat ?? raw.gst),
    totalCents: parseMoney(raw.total ?? raw.grandTotal ?? raw.grand_total),
    warnings: [],
    rawText: typeof raw.rawText === "string" ? raw.rawText.trim().slice(0, 8000) : "",
  };

  if (!reading.lines.length && !reading.vendor && reading.totalCents === null) return null;

  if (datePrinted && !reading.purchaseDate) reading.warnings.push(`The date "${datePrinted}" could not be read as a date. Enter it by hand.`);
  for (const [i, l] of reading.lines.entries()) {
    if (l.unitPriceCents !== null && l.totalCents !== null && Math.abs(l.unitPriceCents * l.quantity - l.totalCents) > TOLERANCE_CENTS) {
      reading.warnings.push(`Line ${i + 1}: ${l.quantity} × ${money(l.unitPriceCents)} is not ${money(l.totalCents)}.`);
    }
  }
  const priced = reading.lines.filter((l) => l.totalCents !== null);
  if (priced.length) {
    const sum = priced.reduce((n, l) => n + l.totalCents!, 0);
    const expected =
      reading.subtotalCents ??
      (reading.totalCents !== null ? reading.totalCents - (reading.taxCents ?? 0) : null);
    // Only when every line has a price: a partly read receipt cannot add up.
    if (expected !== null && priced.length === reading.lines.length && Math.abs(sum - expected) > TOLERANCE_CENTS) {
      reading.warnings.push(
        `The lines add up to ${money(sum)} but the receipt says ${money(expected)}${reading.subtotalCents !== null ? " before tax" : ""}. A line may be missing or misread.`,
      );
    }
  }
  if (
    reading.subtotalCents !== null &&
    reading.taxCents !== null &&
    reading.totalCents !== null &&
    Math.abs(reading.subtotalCents + reading.taxCents - reading.totalCents) > TOLERANCE_CENTS
  ) {
    reading.warnings.push(
      `Subtotal ${money(reading.subtotalCents)} plus tax ${money(reading.taxCents)} is not the total ${money(reading.totalCents)}.`,
    );
  }
  return reading;
}
