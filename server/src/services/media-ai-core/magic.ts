import type { AttachmentKind } from "../../db/tables/media-ai-core";

/**
 * File type detection from the first bytes of a file.
 *
 * The Content-Type a client sends is a claim, not a fact: a phone labels a
 * HEIC as image/jpeg, a browser sends application/octet-stream for anything it
 * does not recognise, and a hostile client can call an HTML page a photo. What
 * we store and later serve with that type is decided here instead, from the
 * bytes. The declared type only breaks ties the bytes cannot, such as whether a
 * WebM holds video or audio only.
 *
 * Deliberately absent: SVG and HTML. Both run script when served from our own
 * origin, and no attachment needs them.
 */

/** How many leading bytes detectMime and imageSize want to see. */
export const SNIFF_BYTES = 4100;

const OFFICE = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

const TEXT = new Set(["text/plain", "text/csv", "application/json", "text/markdown"]);

const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);

/** "Image/JPEG; charset=x" → "image/jpeg". */
export function normalizeMime(value: string | null | undefined): string {
  return (value ?? "").split(";")[0]!.trim().toLowerCase();
}

const ascii = (b: Uint8Array, start: number, end: number) =>
  Buffer.from(b.subarray(start, end)).toString("latin1");

function isoBrands(b: Uint8Array): string[] {
  if (b.length < 12 || ascii(b, 4, 8) !== "ftyp") return [];
  const boxSize = Math.min(((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0, b.length);
  const brands = [ascii(b, 8, 12)];
  // Compatible brands follow the four-byte minor version.
  for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(ascii(b, i, i + 4));
  return brands;
}

function looksLikeText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 1024);
  for (let i = 0; i < n; i++) {
    const c = b[i]!;
    // Tab, line feed, form feed and carriage return are the only control
    // characters plain text has any business containing.
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d) return false;
  }
  return true;
}

/**
 * The canonical MIME type of a file from its first bytes (pass at least
 * SNIFF_BYTES when the file is that long), or null when it is not a type we
 * accept.
 */
export function detectMime(head: Uint8Array, declared?: string | null): string | null {
  const b = head;
  const claimed = normalizeMime(declared);
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);

  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "image/gif";

  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF") {
    const form = ascii(b, 8, 12);
    if (form === "WEBP") return "image/webp";
    if (form === "WAVE") return "audio/wav";
    if (form === "AVI ") return "video/x-msvideo";
    return null;
  }

  const brands = isoBrands(b);
  if (brands.length) {
    const major = brands[0]!;
    if (brands.includes("avif") || brands.includes("avis")) return "image/avif";
    if (brands.some((x) => HEIC_BRANDS.has(x))) return "image/heic";
    if (major === "mif1" || major === "msf1") return "image/heif";
    if (major === "qt  ") return "video/quicktime";
    if (major === "M4A " || major === "M4B " || major === "M4P ") return "audio/mp4";
    if (major.startsWith("3gp") || major.startsWith("3g2")) {
      return claimed.startsWith("audio/") ? "audio/3gpp" : "video/3gpp";
    }
    // Everything else in this family is an MP4 container. Safari's recorder
    // writes audio-only MP4 under the same brands as video, so trust the
    // declared audio type here.
    return claimed.startsWith("audio/") ? "audio/mp4" : "video/mp4";
  }

  if (starts(0x1a, 0x45, 0xdf, 0xa3)) {
    const header = ascii(b, 0, Math.min(b.length, 64));
    if (header.includes("webm")) return claimed.startsWith("audio/") ? "audio/webm" : "video/webm";
    if (header.includes("matroska")) return "video/x-matroska";
    return null;
  }

  if (b.length >= 4 && ascii(b, 0, 4) === "OggS") return claimed.startsWith("video/") ? "video/ogg" : "audio/ogg";
  if (b.length >= 4 && ascii(b, 0, 4) === "fLaC") return "audio/flac";
  if (b.length >= 3 && ascii(b, 0, 3) === "ID3") return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff) {
    // ADTS AAC: sync word plus layer 00.
    if ((b[1]! & 0xf6) === 0xf0) return "audio/aac";
    // MPEG audio frame: sync bits plus a layer that is not the reserved 00.
    if ((b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return "audio/mpeg";
  }

  if (b.length >= 5 && ascii(b, 0, 5) === "%PDF-") return "application/pdf";

  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    // Office documents are zip files; the bytes alone cannot say which kind.
    return OFFICE.has(claimed) ? claimed : "application/zip";
  }

  if (TEXT.has(claimed) && b.length > 0 && looksLikeText(b)) return claimed;
  return null;
}

/** The kind a file most naturally is, for uploads that do not say. */
export function inferKind(mime: string): AttachmentKind {
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/** Whether a detected type fits the kind the uploader asked for. */
export function kindAccepts(kind: AttachmentKind, mime: string): boolean {
  switch (kind) {
    case "photo":
      return mime.startsWith("image/");
    case "video":
      return mime.startsWith("video/");
    case "audio":
      return mime.startsWith("audio/");
    case "signature":
      return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
    case "document":
      // A scanned page is a document too.
      return !mime.startsWith("video/") && !mime.startsWith("audio/");
  }
}

/** Types a browser can show in place rather than download. */
export function isInlineMime(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf" ||
    mime === "text/plain"
  );
}

export type ImageInfo = { width: number; height: number; orientation: number };

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

/**
 * EXIF orientation (1 to 8) from a JPEG APP1 segment; 1 when absent. Phones
 * store portrait photos sideways and set this, so anything that redraws the
 * pixels (thumbnails, the copy sent to a vision model) has to apply it.
 */
export function exifOrientation(app1: Uint8Array): number {
  // "Exif\0\0" then a TIFF header.
  if (app1.length < 14 || ascii(app1, 0, 6) !== "Exif\0\0") return 1;
  const t = 6;
  const little = ascii(app1, t, t + 2) === "II";
  const r16 = (i: number) => (little ? u16le(app1, i) : u16be(app1, i));
  const r32 = (i: number) =>
    little ? (app1[i]! | (app1[i + 1]! << 8) | (app1[i + 2]! << 16) | (app1[i + 3]! << 24)) >>> 0 : u32be(app1, i);
  const ifd = t + r32(t + 4);
  if (ifd + 2 > app1.length) return 1;
  const entries = r16(ifd);
  for (let e = 0; e < entries; e++) {
    const at = ifd + 2 + e * 12;
    if (at + 12 > app1.length) break;
    if (r16(at) === 0x0112) {
      const value = r16(at + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * Pixel size of a JPEG, PNG, GIF or WebP from its header, without decoding it.
 * Width and height are as stored; `orientation` 5 to 8 means they display
 * swapped. Null for anything else or a truncated header.
 */
export function imageSize(b: Uint8Array): ImageInfo | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 12, 16) === "IHDR") {
    return { width: u32be(b, 16), height: u32be(b, 20), orientation: 1 };
  }
  if (b.length >= 10 && ascii(b, 0, 3) === "GIF") {
    return { width: u16le(b, 6), height: u16le(b, 8), orientation: 1 };
  }
  if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
    const chunk = ascii(b, 12, 16);
    if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, orientation: 1 };
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, orientation: 1 };
    }
    if (chunk === "VP8X") {
      const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
      const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
      return { width: w, height: h, orientation: 1 };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let orientation = 1;
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      // Fill bytes between markers.
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // Markers without a length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = u16be(b, i + 2);
      if (len < 2) return null;
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (i + 9 > b.length) return null;
        return { height: u16be(b, i + 5), width: u16be(b, i + 7), orientation };
      }
      if (marker === 0xe1) orientation = exifOrientation(b.subarray(i + 4, Math.min(b.length, i + 2 + len)));
      if (marker === 0xda) return null; // image data began before any frame header
      i += 2 + len;
    }
    return null;
  }
  return null;
}
