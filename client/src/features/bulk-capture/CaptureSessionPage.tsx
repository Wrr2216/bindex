import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { AlertIcon, ArrowLeftIcon, CameraIcon, CloseIcon, DocumentIcon } from "../../components/icons";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";
import { uploadAttachment } from "../media-ai-core";
import { PaperclipIcon, VideoIcon, errorMessage } from "../media-ai-core/format";
import { captureApi } from "./api";
import { DeskCheckPanel } from "./DeskCheckPanel";
import { DraftReview } from "./DraftReview";
import { BTN, BTN_PRIMARY, INPUT, MINI, MODE_INFO, nextLabel } from "./shared";
import type { CaptureSession, CaptureSource } from "./types";

type Upload = { key: string; name: string; progress: number; error?: string; note?: string };

/** One capture session: add images, analyse them within the cap, review the draft, create. */
export function CaptureSessionPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSession(await captureApi.get(id));
    } catch (err) {
      setError(errorMessage(err, "Could not load this session."));
    }
  }, [id]);

  useEffect(() => {
    void load();
    api.listLocations().then(setLocations).catch(() => undefined);
  }, [load]);

  if (!session) {
    return error ? (
      <div className="space-y-3">
        <BackLink />
        <p className="text-sm text-red-400">{error}</p>
      </div>
    ) : (
      <p className="py-6 text-center text-slate-500">Loading…</p>
    );
  }

  const open = session.status === "open";

  const remove = async () => {
    const created = session.counts.created;
    const warning = created
      ? `Delete “${session.title}”? The ${created} entries already created keep their records and photos.`
      : `Delete “${session.title}” and all its images? Nothing has been created from it yet.`;
    if (!window.confirm(warning)) return;
    try {
      await captureApi.remove(session.id);
      navigate("/capture");
    } catch (err) {
      setError(errorMessage(err, "Could not delete the session."));
    }
  };

  return (
    <div className="space-y-6">
      <BackLink />
      <Header session={session} locations={locations} onChange={setSession} onError={setError} onDelete={() => void remove()} />
      {error && (
        <p className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
            <CloseIcon className="h-4 w-4" />
          </button>
        </p>
      )}
      {notice && <p className="text-sm text-slate-300">{notice}</p>}

      {open && <CapturePanel session={session} reload={load} onNotice={setNotice} />}
      <SourceGrid session={session} onChange={setSession} onError={setError} />
      {open && <AnalyseBar session={session} onChange={setSession} onError={setError} />}
      {session.deskCheck && session.deskCheck.length > 0 && <DeskCheckPanel checks={session.deskCheck} />}
      <DraftReview session={session} locations={locations} onChange={setSession} onError={setError} />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/capture" className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:underline">
      <ArrowLeftIcon className="h-3.5 w-3.5" />
      Bulk capture
    </Link>
  );
}

function Header({
  session,
  locations,
  onChange,
  onError,
  onDelete,
}: {
  session: CaptureSession;
  locations: Location[];
  onChange: (s: CaptureSession) => void;
  onError: (m: string | null) => void;
  onDelete: () => void;
}) {
  const terms = useTerms();
  const open = session.status === "open";
  const [cap, setCap] = useState(String(session.cap.imageCap));
  useEffect(() => setCap(String(session.cap.imageCap)), [session.cap.imageCap]);
  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const sorted = useMemo(() => [...locations].sort((a, b) => label(a).localeCompare(label(b))), [locations, label]);

  const patch = async (p: Parameters<typeof captureApi.update>[1]) => {
    onError(null);
    try {
      onChange(await captureApi.update(session.id, p));
    } catch (err) {
      onError(errorMessage(err, "Could not save that."));
    }
  };

  const rename = () => {
    const title = window.prompt("Session title", session.title);
    if (title && title.trim() && title.trim() !== session.title) void patch({ title: title.trim() });
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {session.modeLabel}
            {session.status === "committed" ? " · finished" : ""}
          </p>
          <h1 className="text-xl font-semibold text-slate-100">{session.title}</h1>
        </div>
        <div className="flex gap-2">
          {open && (
            <button type="button" onClick={rename} className={BTN}>
              Rename
            </button>
          )}
          <button type="button" onClick={onDelete} className={`${BTN} text-red-300`}>
            Delete session
          </button>
        </div>
      </div>

      {open ? (
        <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-slate-400">{terms.location.singular}</span>
            <select
              value={session.locationId ?? ""}
              onChange={(e) => void patch({ locationId: e.target.value || null })}
              className={`${INPUT} mt-1`}
            >
              <option value="">None</option>
              {sorted.map((l) => (
                <option key={l.id} value={l.id}>
                  {label(l)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-slate-400">Image cap</span>
            <span className="mt-1 flex gap-2">
              <input
                type="number"
                min={1}
                max={session.cap.instanceMax}
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                className={INPUT}
              />
              {Number(cap) !== session.cap.imageCap && (
                <button type="button" className={MINI} onClick={() => void patch({ imageCap: Number(cap) })}>
                  Save
                </button>
              )}
            </span>
            <span className="mt-1 block text-xs text-slate-500">Up to {session.cap.instanceMax}, set by an administrator.</span>
          </label>
          {session.mode !== "manifest" ? (
            <label className="flex items-start gap-2 pt-5">
              <input
                type="checkbox"
                checked={session.countRule === "max"}
                onChange={(e) => void patch({ countRule: e.target.checked ? "max" : "sum" })}
                className="mt-1"
              />
              <span className="text-sm text-slate-300">
                Photos overlap
                <span className="block text-xs text-slate-500">Count repeats once, at the largest number seen.</span>
              </span>
            </label>
          ) : (
            <p className="pt-5 text-xs text-slate-500">A line read from two photos of the same page is kept once.</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          {session.locationName ? `${terms.location.singular}: ${session.locationName}. ` : ""}
          Finished {session.committedAt ? new Date(session.committedAt).toLocaleString() : ""}.
        </p>
      )}
    </section>
  );
}

function CapturePanel({
  session,
  reload,
  onNotice,
}: {
  session: CaptureSession;
  reload: () => Promise<void>;
  onNotice: (m: string | null) => void;
}) {
  const info = MODE_INFO[session.mode];
  const lastArea = [...session.sources].reverse().find((s) => s.area)?.area ?? "";
  const [area, setArea] = useState(lastArea || (session.mode === "desk" ? "Desk 1" : ""));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const busy = uploads.some((u) => !u.error && !u.note);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    onNotice(null);
    const list = Array.from(files);
    const room = session.cap.imageCap - session.sources.length;
    if (list.length > room) {
      onNotice(`Only ${Math.max(0, room)} more image${room === 1 ? "" : "s"} fit under this session's cap of ${session.cap.imageCap}.`);
    }
    for (const file of list) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name || "Photo", progress: 0 }]);
      try {
        const a = await uploadAttachment(file, {
          ownerType: "capture_session",
          ownerId: session.id,
          stage: "source",
          onProgress: (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))),
        });
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: 1, note: "Preparing…" } : x)));
        const added = await captureApi.addSource(session.id, a.id, area.trim() || null);
        setUploads((u) => u.filter((x) => x.key !== key));
        if (added.message) onNotice(added.message);
        await reload();
      } catch (err) {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: errorMessage(err, "Upload failed.") } : x)));
      }
    }
  };

  const picker = (label: string, icon: ReactNode, accept: string, opts: { capture?: boolean; multiple?: boolean } = {}) => (
    <label className={`${BTN} cursor-pointer ${busy ? "pointer-events-none opacity-50" : ""}`}>
      {icon}
      {label}
      <input
        type="file"
        accept={accept}
        capture={opts.capture ? "environment" : undefined}
        multiple={opts.multiple}
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          void addFiles(files).finally(() => {
            e.target.value = "";
          });
        }}
      />
    </label>
  );

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-end gap-3">
        {info.area && (
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              {info.area} {session.mode === "walkthrough" ? "(optional)" : "for the next photos"}
            </span>
            <span className="mt-1 flex gap-2">
              <input
                value={area}
                onChange={(e) => setArea(e.target.value)}
                placeholder={session.mode === "desk" ? "Desk 1" : "Whole room"}
                className={`${INPUT} w-44`}
                maxLength={80}
              />
              {session.mode === "desk" && (
                <button type="button" className={BTN} onClick={() => setArea(nextLabel(area || "Desk 0"))}>
                  Next desk
                </button>
              )}
            </span>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          {picker("Take photo", <CameraIcon className="h-4 w-4" />, "image/*", { capture: true })}
          {picker("Add photos", <PaperclipIcon className="h-4 w-4" />, "image/*", { multiple: true })}
          {session.tools.video &&
            session.mode !== "manifest" &&
            picker("Record video", <VideoIcon className="h-4 w-4" />, "video/*", { capture: true })}
          {session.tools.video && session.mode !== "manifest" && picker("Add video", <VideoIcon className="h-4 w-4" />, "video/*")}
          {session.tools.pdf && picker("Add PDF", <DocumentIcon className="h-4 w-4" />, "application/pdf,.pdf", { multiple: true })}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        {session.mode === "walkthrough" &&
          "Stand in each corner and shoot towards the middle; overlap is fine. A video is sampled at one frame every three seconds."}
        {session.mode === "desk" &&
          "One photo per desk, wide enough to show the chair and what is under the desk. Press Next desk before moving on."}
        {session.mode === "manifest" && "Photograph each page flat and filling the frame, or upload the scanned PDF."}
        {!session.tools.video && session.mode !== "manifest" && " Video needs ffmpeg on the server, which is not installed."}
        {!session.tools.pdf && " PDFs need pdftoppm (poppler) on the server, which is not installed; upload images of the pages."}
      </p>
      {uploads.length > 0 && (
        <ul className="space-y-1.5">
          {uploads.map((u) => (
            <li key={u.key} className="rounded-lg bg-slate-800/60 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-slate-300">{u.name}</span>
                {u.error ? (
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}
                    className="text-slate-500 hover:text-slate-200"
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">{u.note ?? `${Math.round(u.progress * 100)}%`}</span>
                )}
              </div>
              {u.error && <p className="mt-1 text-xs text-red-300">{u.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const STATUS_STYLE: Record<CaptureSource["status"], string> = {
  pending: "bg-slate-700 text-slate-200",
  analysing: "bg-sky-700 text-white",
  analysed: "bg-emerald-800 text-emerald-100",
  failed: "bg-red-800 text-red-100",
};

function SourceGrid({
  session,
  onChange,
  onError,
}: {
  session: CaptureSession;
  onChange: (s: CaptureSession) => void;
  onError: (m: string | null) => void;
}) {
  const open = session.status === "open";
  const areaWord = MODE_INFO[session.mode].area;
  if (!session.sources.length) {
    return <p className="text-sm text-slate-500">No images yet. Add photos{session.tools.video ? ", a video" : ""} or a PDF to begin.</p>;
  }

  const act = async (fn: () => Promise<CaptureSession>) => {
    onError(null);
    try {
      onChange(await fn());
    } catch (err) {
      onError(errorMessage(err, "That did not work."));
    }
  };

  const rename = (s: CaptureSource) => {
    const next = window.prompt(`${areaWord ?? "Area"} for ${s.label}`, s.area ?? "");
    if (next === null) return;
    void act(() => captureApi.updateSource(session.id, s.id, next.trim() || null));
  };

  const status = (s: CaptureSource) =>
    s.status === "analysed" ? `${s.found ?? 0} found` : s.status === "analysing" ? "Reading…" : s.status === "failed" ? "Failed" : "Waiting";

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Images <span className="text-slate-500">({session.sources.length})</span>
      </h2>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6">
        {session.sources.map((s) => (
          <li key={s.id} className="space-y-1">
            <a href={s.url} target="_blank" rel="noreferrer" className="relative block aspect-square overflow-hidden rounded-lg border border-slate-800 bg-slate-800">
              <img src={`${s.thumbUrl}?w=320`} alt={s.label} loading="lazy" className="h-full w-full object-cover" />
              <span className={`absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[s.status]}`}>{status(s)}</span>
            </a>
            <div className="flex items-center justify-between gap-1 text-[11px] text-slate-400">
              <span className="truncate" title={s.room ?? undefined}>
                {s.label}
              </span>
              {open && (
                <button
                  type="button"
                  aria-label={`Remove ${s.label}`}
                  onClick={() => {
                    if (window.confirm(`Remove ${s.label}? What it contributed to the list goes with it.`)) {
                      void act(() => captureApi.removeSource(session.id, s.id));
                    }
                  }}
                  className="text-slate-500 hover:text-red-300"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {areaWord && (
              <button
                type="button"
                disabled={!open}
                onClick={() => rename(s)}
                className="block max-w-full truncate rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 disabled:hover:bg-slate-800"
                title={`Change the ${areaWord.toLowerCase()}`}
              >
                {s.area ?? `No ${areaWord.toLowerCase()}`}
              </button>
            )}
            {s.status === "failed" && (
              <div className="text-[11px] text-red-300">
                {s.error}{" "}
                {open && (
                  <button type="button" className="underline" onClick={() => void act(() => captureApi.retrySource(session.id, s.id))}>
                    Try again
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AnalyseBar({
  session,
  onChange,
  onError,
}: {
  session: CaptureSession;
  onChange: (s: CaptureSession) => void;
  onError: (m: string | null) => void;
}) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const stop = useRef(false);
  const waiting = session.toAnalyse;
  const { remaining, used, imageCap } = session.cap;
  const willRun = Math.min(waiting, remaining);

  // Stop the loop when the page goes away.
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );

  if (!waiting && !running) return null;

  const run = async () => {
    stop.current = false;
    setRunning(true);
    setDone(0);
    onError(null);
    try {
      while (!stop.current) {
        const r = await captureApi.analyse(session.id, 2);
        onChange(r.session);
        if (!r.available) {
          onError("No vision model is configured, so nothing could be analysed.");
          break;
        }
        setDone((n) => n + r.analysed + r.failed);
        if (r.analysed + r.failed === 0 || r.session.toAnalyse === 0) break;
      }
    } catch (err) {
      onError(errorMessage(err, "Analysis stopped."));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-900/60 bg-sky-950/20 p-4">
      <div className="text-sm">
        {running ? (
          <p className="text-slate-200">
            Analysing… {done} of {willRun} done.
          </p>
        ) : (
          <p className="text-slate-200">
            {waiting} image{waiting === 1 ? "" : "s"} to analyse.
          </p>
        )}
        <p className="text-xs text-slate-400">
          Each image is one vision request. {used} of this session's {imageCap} used; {remaining} left.
          {waiting > remaining && ` Only ${remaining} can be analysed; raise the cap to read the rest.`}
        </p>
      </div>
      {running ? (
        <button type="button" className={BTN} onClick={() => (stop.current = true)}>
          Stop after this
        </button>
      ) : (
        <button type="button" className={BTN_PRIMARY} disabled={willRun === 0} onClick={() => void run()}>
          Analyse {willRun} image{willRun === 1 ? "" : "s"}
        </button>
      )}
    </section>
  );
}
