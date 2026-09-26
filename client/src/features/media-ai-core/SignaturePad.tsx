import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Point = { x: number; y: number };
type Stroke = Point[];

const INK = "#0f172a";
const WIDTH = 2.5;
const PAD = 8;

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], scale: number, offset: Point = { x: 0, y: 0 }) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = WIDTH * scale;
  for (const stroke of strokes) {
    const pts = stroke.map((p) => ({ x: (p.x - offset.x) * scale, y: (p.y - offset.y) * scale }));
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0]!.x, pts[0]!.y, (WIDTH * scale) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    // Midpoint quadratic curves: smooth without overshooting the pen.
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mid = { x: (pts[i]!.x + pts[i + 1]!.x) / 2, y: (pts[i]!.y + pts[i + 1]!.y) / 2 };
      ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mid.x, mid.y);
    }
    const last = pts[pts.length - 1]!;
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
}

/**
 * The signature as a transparent PNG data URL, cropped to the ink and drawn at
 * twice the on-screen size so it stays crisp in a printed PDF. Null when
 * nothing has been drawn.
 */
export function strokesToPng(strokes: Stroke[], scale = 2): string | null {
  const points = strokes.flat();
  if (!points.length) return null;
  const minX = Math.min(...points.map((p) => p.x)) - PAD;
  const minY = Math.min(...points.map((p) => p.y)) - PAD;
  const maxX = Math.max(...points.map((p) => p.x)) + PAD;
  const maxY = Math.max(...points.map((p) => p.y)) + PAD;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil((maxX - minX) * scale));
  canvas.height = Math.max(1, Math.ceil((maxY - minY) * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawStrokes(ctx, strokes, scale, { x: minX, y: minY });
  return canvas.toDataURL("image/png");
}

/**
 * Draw a signature with a finger, stylus or mouse. Pointer events cover all
 * three; pressure is ignored so every device draws the same line. Clear and
 * undo are built in. `onSigned` receives the PNG (a data URL) after every
 * stroke, or null once the pad is empty again.
 */
export function SignaturePad({
  onSigned,
  height = 180,
  label = "Sign here",
}: {
  onSigned: (png: string | null) => void;
  height?: number;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const drawing = useRef<number | null>(null);
  const [count, setCount] = useState(0);
  const onSignedRef = useRef(onSigned);
  onSignedRef.current = onSigned;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const width = wrap.clientWidth;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawStrokes(ctx, strokes.current, dpr);
  }, [height]);

  useEffect(() => {
    redraw();
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    // Strokes are kept in CSS pixels, so a rotated phone redraws them intact.
    const observer = new ResizeObserver(() => redraw());
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [redraw]);

  const emit = () => {
    setCount(strokes.current.length);
    onSignedRef.current(strokesToPng(strokes.current));
  };

  const point = (e: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = e.pointerId;
    strokes.current.push([point(e)]);
    redraw();
  };

  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawing.current !== e.pointerId) return;
    e.preventDefault();
    const stroke = strokes.current[strokes.current.length - 1];
    if (!stroke) return;
    // Coalesced events keep fast strokes smooth on devices that batch them.
    const native = e.nativeEvent as PointerEvent;
    const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const rect = e.currentTarget.getBoundingClientRect();
    if (events.length) for (const ev of events) stroke.push({ x: ev.clientX - rect.left, y: ev.clientY - rect.top });
    else stroke.push(point(e));
    redraw();
  };

  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawing.current !== e.pointerId) return;
    drawing.current = null;
    emit();
  };

  const undo = () => {
    strokes.current.pop();
    redraw();
    emit();
  };

  const clear = () => {
    strokes.current = [];
    redraw();
    emit();
  };

  return (
    <div className="space-y-2">
      <div ref={wrapRef} className="relative overflow-hidden rounded-lg border border-slate-600 bg-white">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={count ? "Signature" : label}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className="block cursor-crosshair"
          style={{ touchAction: "none", height }}
        />
        {count === 0 && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400">
            {label}
          </span>
        )}
        <span className="pointer-events-none absolute bottom-8 left-6 right-6 border-b border-slate-300" />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={undo}
          disabled={count === 0}
          className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={count === 0}
          className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
