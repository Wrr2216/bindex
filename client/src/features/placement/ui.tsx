import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { floorLabel } from "../jobs-core/ui";
import type { Place, PlacementLine, Tally } from "./types";

/** Pieces shared by the placement screens. */

export const pathText = (p: Place | null | undefined) => (p ? p.path.join(" / ") : "");

/** The last two levels of a path ("Level 5 / 5.14"): what a crew reads from a distance. */
export const shortPath = (p: Place | null | undefined) => (p ? p.path.slice(-2).join(" / ") : "");

export const floorText = (floor: string | null | undefined) => (floor ? floorLabel(floor) : "No floor");

/** The code on the label: the unit's own, else the item's. */
export const labelCode = (l: Pick<PlacementLine, "unitCode" | "assetCode">) => l.unitCode ?? l.assetCode;

/** A floor's colour as a band, with its name in it. */
export function FloorBand({
  floor,
  color,
  size = "md",
  children,
}: {
  floor: string | null;
  color: string;
  size?: "sm" | "md" | "xl";
  children?: ReactNode;
}) {
  const cls = {
    sm: "rounded px-2 py-0.5 text-xs font-semibold",
    md: "rounded-lg px-3 py-1.5 text-sm font-semibold",
    xl: "px-6 py-5 text-4xl font-black uppercase tracking-wide sm:text-6xl",
  }[size];
  return (
    <div className={`${cls} text-white`} style={{ backgroundColor: color }}>
      {floorText(floor)}
      {children}
    </div>
  );
}

/** One placement bar: placed of total, with the exceptions called out. */
export function PlacementBar({
  tally,
  label,
  color,
  sub,
}: {
  tally: Tally;
  label: ReactNode;
  color?: string;
  sub?: ReactNode;
}) {
  const exceptions = Object.entries(tally.exceptions);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="flex items-center gap-2 text-slate-200">
          {color && <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: color }} />}
          {label}
        </span>
        <span className="tabular-nums text-slate-400">
          {tally.placed}/{tally.total} placed
          {exceptions.map(([stage, n]) => (
            <span key={stage} className="ml-2 text-orange-300">
              {n} {stage.replace(/_/g, " ")}
            </span>
          ))}
        </span>
      </div>
      <div
        className="mt-1 h-2.5 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-valuenow={tally.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full ${tally.total > 0 && tally.placed === tally.total ? "bg-emerald-500" : "bg-sky-500"}`}
          style={{ width: `${tally.percent}%` }}
        />
      </div>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

/** The bar across the top of a full-screen mode, with the way back out. */
export function ModeHeader({ jobId, title, children }: { jobId: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-3">
      <Link
        to={`/placement/jobs/${jobId}`}
        className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
      >
        Exit
      </Link>
      <h1 className="text-lg font-semibold text-slate-100">{title}</h1>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Covers the page, below the camera button and the reader control. */
export const FULL_SCREEN = "fixed inset-0 z-30 flex flex-col overflow-hidden bg-slate-950";
