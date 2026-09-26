import type { SVGProps } from "react";
import type { AttachmentKind } from "./types";

/** Small helpers and glyphs local to this feature. */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** "before" → "Before", "pre_move" → "Pre move". */
export const stageLabel = (stage: string) => {
  const s = stage.replace(/[_-]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export const errorMessage = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof Error && err.message ? err.message : fallback;

/** The kind a picked file would be stored as, given what this place accepts. */
export function kindForFile(file: File, allowed: AttachmentKind[]): AttachmentKind | null {
  const t = file.type;
  const want: AttachmentKind = t.startsWith("image/")
    ? "photo"
    : t.startsWith("video/")
      ? "video"
      : t.startsWith("audio/")
        ? "audio"
        : "document";
  if (allowed.includes(want)) return want;
  // A scanned page is still a document.
  if (want === "photo" && allowed.includes("document")) return "document";
  return null;
}

const DOCUMENT_ACCEPT = ".pdf,.txt,.csv,.json,.docx,.xlsx,.pptx,.odt,.ods,.odp";

export function acceptFor(kinds: AttachmentKind[]): string {
  const parts: string[] = [];
  if (kinds.includes("photo") || kinds.includes("document")) parts.push("image/*");
  if (kinds.includes("video")) parts.push("video/*");
  if (kinds.includes("audio")) parts.push("audio/*");
  if (kinds.includes("document")) parts.push(DOCUMENT_ACCEPT);
  return parts.join(",");
}

/**
 * Duration and size of a video or audio file, read by the browser before it is
 * uploaded (the server does not decode media). Best effort: resolves with
 * nothing after a few seconds rather than holding up the upload.
 */
export function probeMedia(file: File): Promise<{ width?: number; height?: number; durationMs?: number }> {
  if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) return Promise.resolve({});
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const url = URL.createObjectURL(file);
    const done = (info: { width?: number; height?: number; durationMs?: number }) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(info);
    };
    const timer = setTimeout(() => done({}), 4000);
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const video = el as HTMLVideoElement;
      done({
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        durationMs: Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : undefined,
      });
    };
    el.onerror = () => done({});
    el.src = url;
  });
}

type IconProps = SVGProps<SVGSVGElement>;
const Glyph = ({ children, ...props }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-4 w-4" {...props}>
    {children}
  </svg>
);

export const PlayIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M7 4v16l13-8Z" fill="currentColor" />
  </Glyph>
);
export const VideoIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="2" y="6" width="14" height="12" rx="2" />
    <path d="m16 10 6-3v10l-6-3" />
  </Glyph>
);
export const MicIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
  </Glyph>
);
export const PaperclipIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
  </Glyph>
);
export const ScanTextIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 9h10M7 13h10M7 17h6" />
  </Glyph>
);

export const KIND_LABEL: Record<AttachmentKind, string> = {
  photo: "Photo",
  video: "Video",
  audio: "Audio",
  document: "Document",
  signature: "Signature",
};
