import { useState, type CSSProperties } from "react";
import { useFeatures } from "../../config/useConfig";
import { useAiAvailability } from "../media-ai-core";
import type { Bbox, CaptureMode } from "./types";

/** Shared pieces of the bulk capture screens. */

export const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
export const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
export const MINI =
  "rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50";
export const INPUT =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";

/** Whether bulk capture is switched on and has a vision model to work with. */
export function useBulkCaptureEnabled(): boolean {
  const features = useFeatures();
  const ai = useAiAvailability();
  return Boolean(features.bulkCapture) && ai.vision;
}

export const MODE_INFO: Record<CaptureMode, { title: string; blurb: string; area: string | null }> = {
  walkthrough: {
    title: "Walkthrough",
    blurb: "Photograph a room or walk a floor with a short video. Overlapping shots are merged.",
    area: "Room",
  },
  desk: {
    title: "Desk survey",
    blurb: "One photo per desk or workstation. Each desk is checked against the standard kit.",
    area: "Desk",
  },
  manifest: {
    title: "Paper inventory",
    blurb: "Photograph the pages or upload a PDF of a paper inventory or manifest, handwritten or printed.",
    area: null,
  },
};

/** "Desk 4" → "Desk 5", "4B-12" → "4B-13", "Reception" → "Reception 2". */
export function nextLabel(label: string): string {
  const m = /^(.*?)(\d+)(\D*)$/.exec(label.trim());
  if (!m) return label.trim() ? `${label.trim()} 2` : "";
  const n = String(Number(m[2]) + 1).padStart(m[2]!.length, "0");
  return `${m[1]}${n}${m[3]}`;
}

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "" : `${Math.round(n * 100)}%`);

/**
 * A square preview of one region of a photo, scaled without stretching. Until
 * the photo loads (and when there is no box) it shows the whole photo.
 */
export function BboxThumb({
  src,
  bbox,
  alt,
  className = "h-16 w-16",
}: {
  src: string;
  bbox: Bbox | null;
  alt: string;
  className?: string;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  let style: CSSProperties | undefined;
  if (bbox && size) {
    const bw = bbox.w * size.w;
    const bh = bbox.h * size.h;
    const side = Math.max(bw, bh) * 1.1;
    const left = bbox.x * size.w - (side - bw) / 2;
    const top = bbox.y * size.h - (side - bh) / 2;
    style = {
      position: "absolute",
      maxWidth: "none",
      width: `${(size.w / side) * 100}%`,
      left: `${(-left / side) * 100}%`,
      top: `${(-top / side) * 100}%`,
    };
  }
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-800 ${className}`}>
      {!broken && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setBroken(true)}
          className={style ? "" : "h-full w-full object-cover"}
          style={style}
        />
      )}
    </div>
  );
}
