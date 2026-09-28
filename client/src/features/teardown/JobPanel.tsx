import { useState } from "react";
import { AlertIcon } from "../../components/icons";
import { Modal } from "../media-ai-core";
import { teardownApi } from "./api";
import { clock, errorMessage, isBusy, jobLine, partLine } from "./format";
import type { Guide, TeardownStatus } from "./types";

const BTN = "rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
const PRIMARY = "rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";

/**
 * Where processing stands: progress while it runs, the reason when it failed,
 * what was skipped and why, and steps read from the narration that are
 * waiting for someone to accept them.
 */
export function JobPanel({ guide, status, onChange }: { guide: Guide; status: TeardownStatus | null; onChange: (g: Guide) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { job, draft } = guide;

  const run = async (fn: () => Promise<Guide>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const running = isBusy(job.status);
  const stopped = job.notes.some((n) => n.code === "stopped");
  const neverRead = !running && job.status === "idle" && !guide.transcript && !stopped && !!guide.video;
  const notes = running ? [] : job.notes.filter((n) => n.code !== "stopped" && n.code !== "draft_pending");

  return (
    <div className="space-y-3">
      {running && (
        <div className="rounded-xl border border-sky-900 bg-sky-950/40 p-3" role="status">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-sm text-sky-200">
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" aria-hidden />
              <span className="truncate">{jobLine(job)}…</span>
            </div>
            <button type="button" disabled={busy} onClick={() => void run(() => teardownApi.cancel(guide.id))} className={BTN}>
              Stop
            </button>
          </div>
          {job.progress && job.progress.total > 1 && (
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-800">
              <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round((job.progress.done / job.progress.total) * 100)}%` }} />
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400">You can leave this page; the guide keeps being processed on the server.</p>
        </div>
      )}

      {job.status === "failed" && (
        <div className="rounded-xl border border-red-900 bg-red-950/40 p-3">
          <p className="flex gap-2 text-sm text-red-200">
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{job.error}</span>
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => void run(() => teardownApi.process(guide.id))} className={PRIMARY}>
              Try again
            </button>
          </div>
        </div>
      )}

      {!running && stopped && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm text-slate-300">
          <span>Processing was stopped before it finished.</span>
          <button type="button" disabled={busy} onClick={() => void run(() => teardownApi.process(guide.id))} className={BTN}>
            Continue
          </button>
        </div>
      )}

      {neverRead && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm text-slate-300">
          <span>
            {status?.transcription
              ? "Read the narration to write the steps and parts from it."
              : "Speech to text is not set up, so write the steps by hand. Processing still takes a picture per timed step."}
          </span>
          <button type="button" disabled={busy} onClick={() => void run(() => teardownApi.process(guide.id))} className={PRIMARY}>
            {status?.transcription ? "Read the narration" : "Process"}
          </button>
        </div>
      )}

      {draft?.complete && !running && (
        <DraftReview
          guide={guide}
          busy={busy}
          onApply={() => void run(() => teardownApi.applyDraft(guide.id))}
          onDiscard={() => void run(() => teardownApi.discardDraft(guide.id))}
        />
      )}

      {notes.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
          {notes.map((n) => (
            <li key={n.code}>{n.message}</li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

function DraftReview({ guide, busy, onApply, onDiscard }: { guide: Guide; busy: boolean; onApply: () => void; onDiscard: () => void }) {
  const [open, setOpen] = useState(false);
  if (!guide.draft?.complete) return null;
  const { steps, parts } = guide.draft;
  return (
    <div className="rounded-xl border border-amber-800/70 bg-amber-950/30 p-3 text-sm">
      <p className="text-amber-100">
        The narration gave {steps.length} step{steps.length === 1 ? "" : "s"} and {parts.length} part{parts.length === 1 ? "" : "s"}. Using them
        replaces the {guide.steps.length} step{guide.steps.length === 1 ? "" : "s"} and {guide.parts.length} part
        {guide.parts.length === 1 ? "" : "s"} here.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={onApply} className={PRIMARY}>
          Use them
        </button>
        <button type="button" disabled={busy} onClick={onDiscard} className={BTN}>
          Discard
        </button>
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-sm text-amber-300 hover:underline">
          {open ? "Hide" : "Preview"}
        </button>
      </div>
      {open && (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-slate-300">
          {steps.map((s, i) => (
            <li key={i}>
              {s.title}
              {s.start !== null && <span className="ml-2 font-mono text-xs text-slate-500">{clock(s.start)}</span>}
              {parts.some((p) => p.step === i + 1) && (
                <span className="ml-2 text-xs text-slate-500">
                  {parts
                    .filter((p) => p.step === i + 1)
                    .map(partLine)
                    .join(", ")}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Pick which hardware bags to label, then print them on the label printer. */
export function BagLabelsDialog({ guide, onClose }: { guide: Guide; onClose: () => void }) {
  const bags = [
    ...guide.steps
      .map((s) => ({ n: s.n, title: `Step ${s.n}: ${s.title}`, parts: guide.parts.filter((p) => p.kind === "hardware" && p.stepN === s.n) }))
      .filter((b) => b.parts.length),
    ...(guide.parts.some((p) => p.kind === "hardware" && p.stepN === null)
      ? [{ n: 0, title: "Hardware not tied to a step", parts: guide.parts.filter((p) => p.kind === "hardware" && p.stepN === null) }]
      : []),
  ];
  const [picked, setPicked] = useState<Set<number>>(() => new Set(bags.map((b) => b.n)));

  return (
    <Modal title="Label the hardware bags" onClose={onClose}>
      {bags.length === 0 ? (
        <p className="text-sm text-slate-400">
          No hardware is listed yet. Parts of kind Hardware (screws, bolts, clips) get a bag label per step.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            One label per bag, with the step and what goes in it. The barcode is the {guide.unit ? "unit's" : "item's"} own code, and the QR opens this
            guide at that step.
          </p>
          <ul className="space-y-1">
            {bags.map((b) => (
              <li key={b.n}>
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-sky-500"
                    checked={picked.has(b.n)}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(b.n);
                        else next.delete(b.n);
                        return next;
                      })
                    }
                  />
                  <span>
                    <span className="text-slate-200">{b.title}</span>
                    <span className="block text-xs text-slate-500">{b.parts.map(partLine).join(", ")}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">Print at 100% scale on the label roll, the same as item labels.</p>
          <div className="flex justify-end">
            <a
              href={teardownApi.bagLabelsUrl(guide.id, [...picked])}
              target="_blank"
              rel="noreferrer"
              aria-disabled={picked.size === 0}
              className={`${PRIMARY} ${picked.size === 0 ? "pointer-events-none opacity-50" : ""}`}
            >
              Print {picked.size} label{picked.size === 1 ? "" : "s"}
            </a>
          </div>
        </div>
      )}
    </Modal>
  );
}
