import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/**
 * Anomalies opened and resolved per day: two lines on one axis, a legend,
 * end labels, a crosshair that snaps to the nearest day with one tooltip for
 * both series, arrow-key stepping for keyboard users, and a table view.
 * Colours are categorical slots 1 and 2, validated against the page surface.
 */

type Point = { day: string; opened: number; resolved: number };

const SERIES = [
  { key: "opened", label: "Opened", color: "#3987e5" },
  { key: "resolved", label: "Resolved", color: "#d95926" },
] as const;

const SURFACE = "#0f172a";
const GRID = "#1e293b";
const AXIS = "#334155";
const HEIGHT = 200;
const PAD = { top: 12, right: 76, bottom: 26, left: 32 };

/** Clean tick steps: 1, 2, 5, 10, 20, 50… */
function ticks(max: number): number[] {
  const top = Math.max(1, max);
  const raw = top / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  const out: number[] = [];
  for (let v = 0; v <= top + step * 0.001; v += step) out.push(Math.round(v));
  if (out[out.length - 1]! < top) out.push(out[out.length - 1]! + Math.round(step));
  return out;
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  // Starts narrow so the first paint cannot push a phone-width page sideways.
  const [width, setWidth] = useState(280);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function TrendChart({ data, title }: { data: Point[]; title: string }) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const max = Math.max(0, ...data.flatMap((d) => [d.opened, d.resolved]));
  const yTicks = useMemo(() => ticks(max), [max]);
  const yMax = yTicks[yTicks.length - 1]!;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const path = (k: "opened" | "resolved") => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join("");

  // A label every few days, as many as fit.
  const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 70))));

  const nearest = (clientX: number, box: DOMRect) => {
    const px = clientX - box.left;
    if (data.length <= 1) return 0;
    const i = Math.round(((px - PAD.left) / plotW) * (data.length - 1));
    return Math.min(data.length - 1, Math.max(0, i));
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setHover((h) => {
        const cur = h ?? data.length - 1;
        return Math.min(data.length - 1, Math.max(0, cur + (e.key === "ArrowLeft" ? -1 : 1)));
      });
    }
    if (e.key === "Escape") setHover(null);
  };

  const last = data[data.length - 1];
  const totals = { opened: data.reduce((s, d) => s + d.opened, 0), resolved: data.reduce((s, d) => s + d.resolved, 0) };
  // End labels sit by their line's last point; when the two would collide the
  // legend and tooltip carry identity instead.
  const endY = last ? SERIES.map((s) => y(last[s.key])) : [];
  const collide = endY.length === 2 && Math.abs(endY[0]! - endY[1]!) < 14;
  const hovered = hover === null ? null : data[hover];
  const tipLeft = hover === null ? 0 : Math.min(Math.max(x(hover) + 10, 0), width - 150);

  return (
    <figure className="min-w-0 space-y-2">
      <figcaption id={titleId} className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</span>
        <span className="flex gap-3 text-xs text-slate-400">
          {SERIES.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <svg width="14" height="4" aria-hidden="true">
                <line x1="0" y1="2" x2="14" y2="2" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
              </svg>
              {s.label} <span className="text-slate-500">({totals[s.key]})</span>
            </span>
          ))}
        </span>
      </figcaption>
      <div ref={ref} className="relative w-full min-w-0">
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover((h) => h ?? data.length - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
          className="block touch-none outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? AXIS : GRID} strokeWidth="1" />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="#64748b" className="tabular-nums">
                {t.toLocaleString()}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % every === 0 || i === data.length - 1 ? (
              <text key={d.day} x={x(i)} y={HEIGHT - 8} textAnchor="middle" fontSize="10" fill="#64748b">
                {dayLabel(d.day)}
              </text>
            ) : null,
          )}
          {SERIES.map((s) => (
            <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {last &&
            SERIES.map((s, si) => (
              <g key={s.key}>
                <circle cx={x(data.length - 1)} cy={y(last[s.key])} r="4" fill={s.color} stroke={SURFACE} strokeWidth="2" />
                {!collide && (
                  <text x={x(data.length - 1) + 8} y={endY[si]} dy="0.32em" fontSize="11" fill="#cbd5e1">
                    {s.label} {last[s.key]}
                  </text>
                )}
              </g>
            ))}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="#94a3b8" strokeWidth="1" />
              {SERIES.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(data[hover]![s.key])} r="4" fill={s.color} stroke={SURFACE} strokeWidth="2" />
              ))}
            </g>
          )}
        </svg>
        {hovered && (
          <div
            className="pointer-events-none absolute top-1 rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs shadow-lg"
            style={{ left: tipLeft }}
            role="status"
          >
            <p className="mb-1 text-slate-400">{dayLabel(hovered.day)}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="flex items-center gap-2">
                <svg width="10" height="4" aria-hidden="true">
                  <line x1="0" y1="2" x2="10" y2="2" stroke={s.color} strokeWidth="2" strokeLinecap="round" />
                </svg>
                <strong className="font-semibold text-slate-100 tabular-nums">{hovered[s.key]}</strong>
                <span className="text-slate-400">{s.label.toLowerCase()}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">Show as a table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="px-2 py-1 font-medium">Day</th>
                <th className="px-2 py-1 text-right font-medium">Opened</th>
                <th className="px-2 py-1 text-right font-medium">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.day} className="border-t border-slate-800 text-slate-300">
                  <td className="px-2 py-1">{dayLabel(d.day)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{d.opened}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{d.resolved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
