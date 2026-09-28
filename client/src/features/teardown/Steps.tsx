import { useState, type RefObject } from "react";
import { AlertIcon, CheckIcon, PencilIcon } from "../../components/icons";
import { uploadAttachment } from "../media-ai-core";
import { teardownApi } from "./api";
import { KIND_TONE, clock, errorMessage, parseClock, partLine } from "./format";
import type { Guide, Part, Step } from "./types";

const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
const LABEL = "text-xs font-medium uppercase tracking-wide text-slate-400";
const SMALL_BTN = "rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50";

export const PlayGlyph = () => (
  <svg viewBox="0 0 24 24" className="h-3 w-3" aria-hidden>
    <path d="M7 4v16l13-8Z" fill="currentColor" />
  </svg>
);

/** A still of the video as it is paused now, for a step's picture. */
function captureFrame(video: HTMLVideoElement): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) return Promise.resolve(null);
  const scale = Math.min(1, 1280 / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

export function StepCard({
  step,
  parts,
  reassembly,
  hasVideo,
  highlighted,
  onPlay,
  onEdit,
  onTogglePart,
}: {
  step: Step;
  parts: Part[];
  reassembly: boolean;
  hasVideo: boolean;
  highlighted: boolean;
  onPlay: () => void;
  onEdit: () => void;
  onTogglePart: (part: Part, refitted: boolean) => void;
}) {
  const timed = hasVideo && step.start !== null;
  const done = reassembly && parts.length > 0 && parts.every((p) => p.reassembledAt);
  return (
    <li
      id={`step-${step.n}`}
      className={`scroll-mt-24 rounded-xl border bg-slate-900 p-3 ${highlighted ? "border-sky-600" : "border-slate-800"}`}
    >
      <div className="flex gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
            done ? "bg-emerald-800 text-emerald-100" : "bg-slate-800 text-slate-100"
          }`}
          aria-label={`Step ${step.n}`}
        >
          {done ? <CheckIcon className="h-4 w-4" /> : step.n}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {/* The picture sits beside the title only, so on a phone the
              instruction and parts below get the whole width. */}
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-medium text-slate-100">
                  {reassembly && <span className="mr-1 text-xs font-normal uppercase tracking-wide text-slate-500">Refit</span>}
                  {step.title}
                </h3>
                {!reassembly && (
                  <button type="button" onClick={onEdit} aria-label={`Edit step ${step.n}`} className="shrink-0 text-slate-400 hover:text-slate-100">
                    <PencilIcon className="h-4 w-4" />
                  </button>
                )}
              </div>
              {timed && (
                <button
                  type="button"
                  onClick={onPlay}
                  className="inline-flex items-center gap-1.5 rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-sky-300 hover:bg-slate-700"
                  title="Play this step's clip"
                >
                  <PlayGlyph />
                  {clock(step.start)}
                  {step.end !== null && step.end > (step.start ?? 0) ? `–${clock(step.end)}` : ""}
                </button>
              )}
            </div>
            {step.keyframe && (
              <button type="button" onClick={timed ? onPlay : undefined} className="shrink-0" aria-label={`Picture of step ${step.n}`}>
                <img
                  src={`${step.keyframe.thumbUrl ?? step.keyframe.url}?w=320`}
                  alt=""
                  loading="lazy"
                  className="h-16 w-24 rounded-lg border border-slate-800 object-cover sm:h-24 sm:w-32"
                />
              </button>
            )}
          </div>
          {step.instruction && step.instruction !== step.title && (
            <p className="whitespace-pre-line text-sm text-slate-300">{step.instruction}</p>
          )}
          {step.callout && (
            <p className="flex gap-2 rounded-lg border border-amber-800/70 bg-amber-950/50 px-3 py-2 text-sm font-medium text-amber-200">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{step.callout}</span>
            </p>
          )}
          {parts.length > 0 &&
            (reassembly ? (
              <ul className="space-y-1.5">
                {parts.map((p) => (
                  <li key={p.id}>
                    <label className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={p.reassembledAt !== null}
                        onChange={(e) => onTogglePart(p, e.target.checked)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
                      />
                      <span className={`min-w-0 flex-1 ${p.reassembledAt ? "text-slate-500 line-through" : "text-slate-200"}`}>{partLine(p)}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase ${KIND_TONE[p.kind]}`}>{p.kind}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {parts.map((p) => (
                  <span key={p.id} className={`rounded px-2 py-0.5 text-xs ${KIND_TONE[p.kind]}`} title={p.heardAs ? `Heard as "${p.heardAs}"` : undefined}>
                    {partLine(p)}
                  </span>
                ))}
              </div>
            ))}
        </div>
      </div>
    </li>
  );
}

/**
 * Write or change a step. New steps start at the video's current position.
 * Saving or deleting closes the editor (onSaved); taking a picture or moving
 * the step keeps it open with whatever has been typed (onChange).
 */
export function StepEditor({
  guide,
  step,
  mediaRef,
  onSaved,
  onChange,
  onCancel,
}: {
  guide: Guide;
  step: Step | null;
  mediaRef: RefObject<HTMLMediaElement | null>;
  onSaved: (guide: Guide) => void;
  onChange: (guide: Guide) => void;
  onCancel: () => void;
}) {
  const now = () => (mediaRef.current ? Math.round(mediaRef.current.currentTime * 10) / 10 : null);
  const [title, setTitle] = useState(step?.title ?? "");
  const [instruction, setInstruction] = useState(step?.instruction ?? "");
  const [callout, setCallout] = useState(step?.callout ?? "");
  const [start, setStart] = useState(clock(step ? step.start : guide.video ? now() : null));
  const [end, setEnd] = useState(clock(step?.end));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasVideo = !!guide.video && guide.video.kind === "video";

  const run = async (fn: () => Promise<Guide>, close = true) => {
    setBusy(true);
    setError(null);
    try {
      (close ? onSaved : onChange)(await fn());
    } catch (err) {
      setError(errorMessage(err, "Could not save the step."));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const s = parseClock(start);
    const e = parseClock(end);
    if (Number.isNaN(s) || Number.isNaN(e)) {
      setError("Write times as minutes and seconds, such as 1:23.");
      return;
    }
    if (!title.trim()) {
      setError("Give the step a title.");
      return;
    }
    const payload = { title: title.trim(), instruction: instruction.trim() || null, callout: callout.trim() || null, start: s, end: e };
    void run(() => (step ? teardownApi.updateStep(step.id, payload) : teardownApi.addStep(guide.id, payload)));
  };

  const takeFrame = async () => {
    const video = mediaRef.current;
    if (!step || !(video instanceof HTMLVideoElement)) return;
    setBusy(true);
    setError(null);
    try {
      video.pause();
      const blob = await captureFrame(video);
      if (!blob) throw new Error("Play the video to the moment you want, then try again.");
      const saved = await uploadAttachment(blob, {
        ownerType: "teardown_guide",
        ownerId: guide.id,
        kind: "photo",
        stage: "keyframe",
        filename: `step-${step.n}.jpg`,
      });
      onChange(await teardownApi.updateStep(step.id, { keyframeAttachmentId: saved.id }));
    } catch (err) {
      setError(errorMessage(err, "Could not take the picture."));
    } finally {
      setBusy(false);
    }
  };

  const setNow = (which: "start" | "end") => {
    const t = now();
    if (t !== null) (which === "start" ? setStart : setEnd)(clock(t));
  };

  return (
    <div className="space-y-3 rounded-xl border border-sky-800 bg-slate-900 p-3">
      <p className={LABEL}>{step ? `Step ${step.n}` : "New step"}</p>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Remove the side panels" maxLength={120} className={FIELD} aria-label="Title" autoFocus />
      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="What to do, in the order you did it"
        rows={3}
        maxLength={2000}
        className={FIELD}
        aria-label="Instruction"
      />
      <input
        value={callout}
        onChange={(e) => setCallout(e.target.value)}
        placeholder="Callout: counts, warnings, labels to add (optional)"
        maxLength={300}
        className={FIELD}
        aria-label="Callout"
      />
      {hasVideo && (
        <div className="grid grid-cols-2 gap-2">
          {(["start", "end"] as const).map((which) => (
            <label key={which} className="block">
              <span className={LABEL}>{which === "start" ? "Starts at" : "Ends at"}</span>
              <div className="mt-1 flex gap-1">
                <input
                  value={which === "start" ? start : end}
                  onChange={(e) => (which === "start" ? setStart : setEnd)(e.target.value)}
                  placeholder="0:00"
                  inputMode="decimal"
                  className={`${FIELD} font-mono`}
                />
                <button type="button" onClick={() => setNow(which)} className={SMALL_BTN} title="Use where the video is now">
                  Now
                </button>
              </div>
            </label>
          ))}
        </div>
      )}
      {step && hasVideo && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void takeFrame()} disabled={busy} className={SMALL_BTN}>
            Use this frame as the picture
          </button>
          {step.keyframe && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => teardownApi.updateStep(step.id, { keyframeAttachmentId: null }), false)}
              className={SMALL_BTN}
            >
              Remove picture
            </button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-3">
        <div className="flex gap-2">
          {step && (
            <>
              <button type="button" disabled={busy || step.n === 1} onClick={() => void run(() => teardownApi.updateStep(step.id, { n: step.n - 1 }), false)} className={SMALL_BTN}>
                Move up
              </button>
              <button
                type="button"
                disabled={busy || step.n === guide.steps.length}
                onClick={() => void run(() => teardownApi.updateStep(step.id, { n: step.n + 1 }), false)}
                className={SMALL_BTN}
              >
                Move down
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Delete step ${step.n}? Its parts stay on the list.`)) void run(() => teardownApi.deleteStep(step.id));
                }}
                className="rounded-lg border border-red-900 px-2.5 py-1 text-xs text-red-300 hover:bg-red-950"
              >
                Delete
              </button>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={busy} className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
            {step ? "Save" : "Add step"}
          </button>
        </div>
      </div>
    </div>
  );
}
