import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeftIcon, DocumentIcon, PencilIcon, PrinterIcon } from "../../components/icons";
import { useFeatures, useTerms } from "../../config/useConfig";
import { Modal } from "../media-ai-core";
import { teardownApi } from "./api";
import { clock, errorMessage, isBusy } from "./format";
import { BagLabelsDialog, JobPanel } from "./JobPanel";
import { PartsPanel } from "./Parts";
import { StepCard, StepEditor } from "./Steps";
import { StatusPill } from "./TeardownSection";
import type { Guide, Part, ProcessMode, TeardownStatus } from "./types";
import { VideoPicker } from "./VideoPicker";

type View = "disassembly" | "reassembly" | "parts";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
const POLL_MS = 2500;

const unitName = (u: { label: string | null; serial: string | null; assetCode: string }) =>
  u.label?.trim() || u.serial?.trim() || u.assetCode;

/**
 * One teardown guide: the video, the numbered steps (each plays the clip it
 * came from), the parts detached, and the same steps in reverse with a box
 * per part for putting it back together.
 */
export function GuidePage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const features = useFeatures();
  const terms = useTerms();
  const [guide, setGuide] = useState<Guide | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [status, setStatus] = useState<TeardownStatus | null>(null);
  const [view, setView] = useState<View>("disassembly");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [bags, setBags] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusStep, setFocusStep] = useState<number | null>(null);
  // The <video>, or an <audio> for a narration recorded without picture.
  const media = useRef<HTMLMediaElement | null>(null);
  const setMedia = useCallback((el: HTMLMediaElement | null) => {
    media.current = el;
  }, []);
  const clipEnd = useRef<number | null>(null);
  const deepLinked = useRef(false);

  const load = useCallback(async () => {
    try {
      setGuide(await teardownApi.get(id));
    } catch (err) {
      setMissing(errorMessage(err, "This guide could not be loaded."));
    }
  }, [id]);

  useEffect(() => {
    void load();
    teardownApi.status().then(setStatus).catch(() => setStatus(null));
  }, [load]);

  // Follow processing on the server until it settles.
  const busy = guide ? isBusy(guide.job.status) : false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  // A bag label's QR code opens the guide at its step: show that step, with
  // the video cued to it.
  useEffect(() => {
    if (!guide || deepLinked.current) return;
    deepLinked.current = true;
    const n = Number(searchParams.get("step"));
    if (Number.isInteger(n) && n > 0 && guide.steps[n - 1]) {
      setFocusStep(n);
      setTimeout(() => document.getElementById(`step-${n}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
      const start = guide.steps[n - 1]!.start;
      if (start !== null && media.current) media.current.currentTime = start;
    } else if (location.hash === "#video") {
      setTimeout(() => document.getElementById("video")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }, [guide, searchParams, location.hash]);

  const change = (g: Guide) => {
    setGuide(g);
    setError(null);
  };

  const mutate = async (fn: () => Promise<Guide>) => {
    setError(null);
    try {
      change(await fn());
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const play = (start: number | null, end: number | null) => {
    const v = media.current;
    if (!v || start === null) return;
    v.currentTime = start;
    clipEnd.current = end !== null && end > start ? end : null;
    void v.play().catch(() => undefined);
    v.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const togglePart = (p: Part, refitted: boolean) => {
    // Tick at once; the server's answer replaces it.
    setGuide((g) =>
      g ? { ...g, parts: g.parts.map((x) => (x.id === p.id ? { ...x, reassembledAt: refitted ? new Date().toISOString() : null } : x)) } : g,
    );
    void mutate(() => teardownApi.updatePart(p.id, { reassembled: refitted }));
  };

  const reprocess = (mode: ProcessMode, question: string) => {
    if (confirm(question)) void mutate(() => teardownApi.process(id, mode));
  };

  if (missing) {
    return (
      <div className="space-y-3 py-10 text-center">
        <p className="text-slate-400">{missing}</p>
        <Link to="/teardown" className="text-sky-400 hover:underline">
          All teardown guides
        </Link>
      </div>
    );
  }
  if (!guide) return <p className="py-10 text-center text-slate-500">Loading…</p>;

  const isVideo = guide.video?.kind === "video";
  const partsOf = (stepId: string) => guide.parts.filter((p) => p.stepId === stepId);
  const unplaced = guide.parts.filter((p) => !p.stepId);
  const refitted = guide.parts.filter((p) => p.reassembledAt).length;
  const hasHardware = guide.parts.some((p) => p.kind === "hardware");
  const steps = view === "reassembly" ? [...guide.steps].reverse() : guide.steps;
  // Until it plays, show the first step's picture rather than a black box.
  const firstPicture = guide.steps.find((s) => s.keyframe)?.keyframe;
  const poster = firstPicture ? `${firstPicture.thumbUrl ?? firstPicture.url}?w=1024` : undefined;

  return (
    <div className="space-y-4">
      <Link to={guide.item ? `/items/${guide.itemId}` : "/teardown"} className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-100">
        <ArrowLeftIcon className="h-4 w-4" />
        {guide.item ? guide.item.name : "Teardown guides"}
      </Link>

      <header className="space-y-2">
        {editingDetails ? (
          <DetailsEditor guide={guide} onSaved={(g) => (change(g), setEditingDetails(false))} onCancel={() => setEditingDetails(false)} />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <h1 className="text-xl font-semibold text-slate-100">{guide.title}</h1>
              <div className="flex shrink-0 items-center gap-2">
                <StatusPill status={guide.job.status} draftPending={guide.draft?.complete} />
                <button type="button" onClick={() => setEditingDetails(true)} aria-label="Edit title and notes" className="text-slate-400 hover:text-slate-100">
                  <PencilIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
            <p className="text-sm text-slate-400">
              {[
                guide.item ? `${guide.item.name} · ${guide.item.assetCode}` : `This ${terms.item.singular.toLowerCase()} was deleted`,
                guide.unit ? `Unit ${unitName(guide.unit)}` : null,
                `${guide.steps.length} step${guide.steps.length === 1 ? "" : "s"}`,
                `${guide.parts.length} part${guide.parts.length === 1 ? "" : "s"}`,
                guide.durationSec ? `video ${clock(guide.durationSec)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {guide.notes && <p className="whitespace-pre-line text-sm text-slate-300">{guide.notes}</p>}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <a href={teardownApi.reportUrl(guide.id)} target="_blank" rel="noreferrer" className={BTN}>
            <DocumentIcon className="h-4 w-4" />
            Report (PDF)
          </a>
          {features.printing && hasHardware && (
            <button type="button" onClick={() => setBags(true)} className={BTN}>
              <PrinterIcon className="h-4 w-4" />
              Bag labels
            </button>
          )}
          <details className="relative">
            <summary className={`${BTN} cursor-pointer list-none`}>More</summary>
            <div className="absolute z-20 mt-1 w-64 space-y-1 rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl">
              {guide.transcript?.complete && (
                <MenuButton
                  disabled={busy}
                  onClick={() => reprocess("steps", "Read the steps again from the transcript? The result is offered for review before it replaces anything.")}
                >
                  Read the steps again
                </MenuButton>
              )}
              {guide.video && (
                <MenuButton
                  disabled={busy}
                  onClick={() => reprocess("all", "Transcribe the video again and read new steps? The result is offered for review before it replaces anything.")}
                >
                  Transcribe again
                </MenuButton>
              )}
              <MenuButton disabled={busy} onClick={() => setAttaching(true)}>
                {guide.video ? "Use a different video" : "Attach a video"}
              </MenuButton>
              <MenuButton
                danger
                onClick={async () => {
                  if (!confirm("Delete this guide? Its steps, parts and step pictures go; the video stays with the record.")) return;
                  try {
                    await teardownApi.remove(guide.id);
                    navigate(guide.item ? `/items/${guide.itemId}` : "/teardown");
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              >
                Delete guide
              </MenuButton>
            </div>
          </details>
        </div>
      </header>

      <JobPanel guide={guide} status={status} onChange={change} />
      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-3 lg:sticky lg:top-20 lg:self-start">
          <div id="video" className="scroll-mt-20 overflow-hidden rounded-xl border border-slate-800 bg-black">
            {guide.video ? (
              isVideo ? (
                <video
                  ref={setMedia}
                  src={guide.video.url}
                  poster={poster}
                  controls
                  playsInline
                  preload="metadata"
                  className="max-h-[50vh] w-full bg-black"
                  onTimeUpdate={(e) => {
                    if (clipEnd.current !== null && e.currentTarget.currentTime >= clipEnd.current) {
                      clipEnd.current = null;
                      e.currentTarget.pause();
                    }
                  }}
                  onPause={() => (clipEnd.current = null)}
                />
              ) : (
                <audio ref={setMedia} src={guide.video.url} controls className="w-full p-2" />
              )
            ) : (
              <div className="space-y-2 bg-slate-900 p-4 text-sm text-slate-400">
                <p>No video yet. Attach one and the narration can be read into steps.</p>
                <button type="button" onClick={() => setAttaching(true)} className={BTN}>
                  Attach a video
                </button>
              </div>
            )}
          </div>
          {guide.transcript && guide.transcript.text && <Transcript guide={guide} onSeek={(t) => play(t, null)} />}
        </div>

        <div className="space-y-3">
          <div className="flex rounded-lg border border-slate-800 bg-slate-900 p-1 text-sm" role="tablist">
            {(
              [
                ["disassembly", "Take apart"],
                ["reassembly", "Put back"],
                ["parts", `Parts${guide.parts.length ? ` (${guide.parts.length})` : ""}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={view === key}
                onClick={() => {
                  setView(key);
                  setEditing(null);
                }}
                className={`flex-1 rounded-md px-3 py-1.5 ${view === key ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
              >
                {label}
              </button>
            ))}
          </div>

          {view === "parts" ? (
            <PartsPanel guide={guide} onChange={change} onToggle={togglePart} />
          ) : (
            <>
              {view === "reassembly" && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm">
                  <span className="text-slate-300">
                    Reverse order. {refitted} of {guide.parts.length} part{guide.parts.length === 1 ? "" : "s"} refitted.
                  </span>
                  {refitted > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm("Clear every tick and start the reassembly again?")) void mutate(() => teardownApi.resetReassembly(guide.id));
                      }}
                      className="text-xs text-sky-400 hover:underline"
                    >
                      Clear ticks
                    </button>
                  )}
                  {guide.parts.length > 0 && (
                    <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
                      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round((refitted / guide.parts.length) * 100)}%` }} />
                    </div>
                  )}
                </div>
              )}
              {guide.steps.length === 0 && editing !== "new" && (
                <p className="rounded-xl border border-dashed border-slate-800 p-4 text-sm text-slate-500">
                  {busy ? "Steps appear here once the narration has been read." : "No steps yet. Add them as you watch the video."}
                </p>
              )}
              <ol className="space-y-2">
                {steps.map((s) =>
                  editing === s.id ? (
                    <li key={s.id}>
                      <StepEditor
                        guide={guide}
                        step={s}
                        mediaRef={media}
                        onSaved={(g) => (change(g), setEditing(null))}
                        onChange={change}
                        onCancel={() => setEditing(null)}
                      />
                    </li>
                  ) : (
                    <StepCard
                      key={s.id}
                      step={s}
                      parts={partsOf(s.id)}
                      reassembly={view === "reassembly"}
                      hasVideo={isVideo}
                      highlighted={focusStep === s.n}
                      onPlay={() => play(s.start, s.end)}
                      onEdit={() => setEditing(s.id)}
                      onTogglePart={togglePart}
                    />
                  ),
                )}
              </ol>
              {view === "reassembly" && unplaced.length > 0 && (
                <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Not tied to a step</p>
                  {unplaced.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={p.reassembledAt !== null} onChange={(e) => togglePart(p, e.target.checked)} className="h-4 w-4 accent-emerald-500" />
                      <span className={p.reassembledAt ? "text-slate-500 line-through" : "text-slate-200"}>
                        {p.qty > 1 ? `${p.qty} × ` : ""}
                        {p.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {view === "disassembly" &&
                (editing === "new" ? (
                  <StepEditor
                    guide={guide}
                    step={null}
                    mediaRef={media}
                    onSaved={(g) => (change(g), setEditing(null))}
                    onChange={change}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <button type="button" onClick={() => setEditing("new")} className={BTN}>
                    Add a step
                  </button>
                ))}
            </>
          )}
        </div>
      </div>

      {attaching && (
        <Modal title={guide.video ? "Use a different video" : "Attach a video"} onClose={() => setAttaching(false)}>
          <VideoPicker
            owners={[
              ...(guide.unitId ? [{ ownerType: "unit" as const, ownerId: guide.unitId }] : []),
              { ownerType: "item" as const, ownerId: guide.itemId },
            ]}
            onPicked={(v) => {
              setAttaching(false);
              void mutate(() => teardownApi.update(guide.id, { videoAttachmentId: v.id, process: true }));
            }}
          />
          {guide.video && (
            <p className="mt-3 text-xs text-slate-500">
              The steps stay. What was read from the old video is dropped, and the new one is read and offered for review.
            </p>
          )}
        </Modal>
      )}
      {bags && <BagLabelsDialog guide={guide} onClose={() => setBags(false)} />}
    </div>
  );
}

function MenuButton({ children, onClick, disabled, danger }: { children: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
        onClick();
      }}
      className={`block w-full rounded-md px-3 py-2 text-left text-sm disabled:opacity-50 ${danger ? "text-red-300 hover:bg-red-950" : "text-slate-200 hover:bg-slate-800"}`}
    >
      {children}
    </button>
  );
}

function DetailsEditor({ guide, onSaved, onCancel }: { guide: Guide; onSaved: (g: Guide) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(guide.title);
  const [notes, setNotes] = useState(guide.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const field = "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 focus:border-sky-500 focus:outline-none";
  return (
    <div className="space-y-2 rounded-xl border border-sky-800 bg-slate-900 p-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={field} aria-label="Title" />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder="Notes: where it is going, who took it apart, tools needed"
        className={`${field} text-sm`}
        aria-label="Notes"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              onSaved(await teardownApi.update(guide.id, { title, notes: notes.trim() || null }));
            } catch (err) {
              setError(errorMessage(err));
              setSaving(false);
            }
          }}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function Transcript({ guide, onSeek }: { guide: Guide; onSeek: (t: number) => void }) {
  const t = guide.transcript!;
  return (
    <details className="rounded-xl border border-slate-800 bg-slate-900 p-3">
      <summary className="cursor-pointer text-sm font-medium text-slate-300">
        Narration{t.complete ? "" : " (partly transcribed)"}
      </summary>
      {t.segments.length ? (
        <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto text-sm">
          {t.segments.map((s, i) => (
            <li key={i} className="flex gap-2">
              <button type="button" onClick={() => onSeek(s.start)} className="shrink-0 font-mono text-xs text-sky-400 hover:underline">
                {clock(s.start)}
              </button>
              <span className="text-slate-300">{s.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 whitespace-pre-line text-sm text-slate-300">{t.text}</p>
      )}
    </details>
  );
}
