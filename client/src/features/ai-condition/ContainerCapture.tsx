import { useState } from "react";
import { AlertIcon, CloseIcon } from "../../components/icons";
import { useTerms } from "../../config/useConfig";
import { Modal } from "../media-ai-core";
import { conditionApi } from "./api";
import { PhotoPicker, type PickedPhoto } from "./PhotoPicker";
import type { ConditionRating, ContainerDraft, ContainerFlag } from "./types";
import { FLAGS, FLAG_LABEL, RATINGS, RATING_LABEL, errorMessage, useConditionAi, useConditionSettings } from "./vocab";

const INPUT =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
const CELL_BASE = "rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100 focus:border-sky-500 focus:outline-none";
const CELL = `${CELL_BASE} w-full`;
const LABEL = "mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400";
const UNSURE = "border-amber-500 ring-1 ring-amber-500";

type Line = {
  key: number;
  name: string;
  category: string;
  qty: number;
  condition: ConditionRating | null;
  fragile: boolean;
  description: string;
  create: boolean;
};

export type CaptureContainer = { id: string; name: string; locationName?: string | null; locationId?: string | null };

let nextKey = 1;
const blankLine = (): Line => ({ key: nextKey++, name: "", category: "", qty: 1, condition: null, fragile: false, description: "", create: true });

/**
 * Photograph a container, let AI read it (or fill it in by hand), check every
 * field, then create its contents as items inside it in one step. The photos
 * are kept on the container with stage "pack".
 */
export function ContainerCapture({
  container,
  onSaved,
  onClose,
}: {
  container: CaptureContainer;
  onSaved: (created: number) => void;
  onClose: () => void;
}) {
  const terms = useTerms();
  const aiOn = useConditionAi();
  const settings = useConditionSettings();
  const [step, setStep] = useState<"photos" | "review">("photos");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [draft, setDraft] = useState<ContainerDraft | null>(null);
  const [lowConfidence, setLowConfidence] = useState(0.6);
  const [message, setMessage] = useState<string | null>(null);

  const [name, setName] = useState(container.name);
  const [sizeClass, setSizeClass] = useState("");
  const [room, setRoom] = useState("");
  const [handwriting, setHandwriting] = useState("");
  const [summary, setSummary] = useState("");
  const [flags, setFlags] = useState<ContainerFlag[]>([]);
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [inherit, setInherit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = async () => {
    setReading(true);
    setMessage(null);
    try {
      const res = await conditionApi.readContainer(container.id, selected);
      if (!res.available) {
        setMessage("No vision model is configured. Fill it in by hand.");
        setStep("review");
        return;
      }
      setLowConfidence(res.lowConfidence);
      if (!res.draft) {
        setMessage(res.message ?? "Nothing could be read. Fill it in by hand, or try other photos.");
        return;
      }
      const d = res.draft;
      setDraft(d);
      setSizeClass(d.sizeClass ?? "");
      setRoom(d.room ?? "");
      setHandwriting(d.handwrittenText ?? "");
      setSummary(d.contentsSummary ?? "");
      setFlags(d.flags);
      setLines(
        d.contents.length
          ? d.contents.map((c) => ({
              key: nextKey++,
              name: c.name,
              category: c.category ?? "",
              qty: c.qty,
              condition: c.condition,
              fragile: c.fragile,
              description: c.description ?? "",
              create: true,
            }))
          : [blankLine()],
      );
      setStep("review");
    } catch (err) {
      setMessage(errorMessage(err, "The photos could not be read."));
    } finally {
      setReading(false);
    }
  };

  const unsure = (field: keyof ContainerDraft["confidence"]) => Boolean(draft && draft.confidence[field] > 0 && draft.confidence[field] < lowConfidence);
  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const filled = lines.filter((l) => l.name.trim());
  const creating = filled.filter((l) => l.create).length;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await conditionApi.saveCapture(container.id, {
        containerName: name.trim() && name.trim() !== container.name ? name.trim() : null,
        sizeClass: sizeClass || null,
        room: room.trim() || null,
        handwrittenText: handwriting.trim() || null,
        contentsSummary: summary.trim() || null,
        flags,
        contents: filled.map((l) => ({
          name: l.name.trim(),
          category: l.category.trim() || null,
          qty: Math.max(1, Math.round(l.qty) || 1),
          condition: l.condition,
          fragile: l.fragile,
          description: l.description.trim() || null,
          create: l.create,
        })),
        attachmentIds: selected,
        aiAssisted: Boolean(draft),
        confidence: draft ? draft.confidence : null,
        inheritLocation: inherit,
      });
      onSaved(res.createdItemIds.length);
    } catch (err) {
      setError(errorMessage(err, "The contents could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const sizes = settings?.sizeClasses ?? [];
  const sizeOptions = sizeClass && !sizes.includes(sizeClass) ? [...sizes, sizeClass] : sizes;
  const suggestedName = draft?.room && draft.contentsSummary ? `${draft.room}: ${draft.contentsSummary}` : null;
  const itemWord = terms.item.plural.toLowerCase();

  return (
    <Modal title={`Pack list: ${container.name}`} onClose={onClose} wide>
      {step === "photos" ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-300">
            Photograph the outside of the container, with any writing or label, and the open top. Up to four photos.
          </p>
          <PhotoPicker
            ownerType="item"
            ownerId={container.id}
            stage="pack"
            photos={photos}
            onPhotos={setPhotos}
            selected={selected}
            onSelected={setSelected}
            max={4}
          />
          {message && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-950/60 px-3 py-2 text-sm text-amber-200">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {aiOn && (
              <button
                type="button"
                onClick={() => void read()}
                disabled={reading || !selected.length}
                className="rounded-lg bg-violet-700 px-4 py-2 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
              >
                {reading ? "Reading the photos…" : "Read with AI"}
              </button>
            )}
            <button type="button" onClick={() => setStep("review")} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">
              Fill in by hand
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {draft && (
            <p className="rounded-lg bg-sky-950/60 px-3 py-2 text-sm text-sky-200">
              Read from the photos. Fields outlined in amber were hard to read. Check everything, then save.
            </p>
          )}
          {message && <p className="rounded-lg bg-amber-950/60 px-3 py-2 text-sm text-amber-200">{message}</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={LABEL}>Container name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={INPUT} />
              {suggestedName && suggestedName !== name && (
                <button type="button" onClick={() => setName(suggestedName)} className="mt-1 text-xs text-sky-400 hover:underline">
                  Use “{suggestedName}”
                </button>
              )}
            </label>
            <label className="block">
              <span className={LABEL}>Size</span>
              <select value={sizeClass} onChange={(e) => setSizeClass(e.target.value)} className={`${INPUT} ${unsure("sizeClass") ? UNSURE : ""}`}>
                <option value="">Not set</option>
                {sizeOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {draft?.sizeClassRaw && <span className="mt-1 block text-xs text-amber-300">The model said “{draft.sizeClassRaw}”, which is not on the list.</span>}
            </label>
            <label className="block">
              <span className={LABEL}>Room or area written on it</span>
              <input value={room} onChange={(e) => setRoom(e.target.value)} maxLength={80} className={`${INPUT} ${unsure("room") ? UNSURE : ""}`} />
            </label>
            <label className="block">
              <span className={LABEL}>Contents in short</span>
              <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={200} className={INPUT} />
            </label>
          </div>

          <label className="block">
            <span className={LABEL}>Writing on the container</span>
            <textarea
              value={handwriting}
              onChange={(e) => setHandwriting(e.target.value)}
              rows={3}
              maxLength={2000}
              className={`${INPUT} font-mono ${unsure("handwrittenText") ? UNSURE : ""}`}
            />
          </label>

          <div>
            <span className={LABEL}>Handling marks</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Handling marks">
              {FLAGS.map((f) => {
                const on = flags.includes(f);
                return (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFlags((cur) => (on ? cur.filter((x) => x !== f) : FLAGS.filter((x) => x === f || cur.includes(x))))}
                    className={`rounded-full px-3 py-1 text-xs ${on ? "bg-amber-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
                  >
                    {FLAG_LABEL[f]}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className={LABEL}>Contents</span>
              {unsure("contents") && <span className="text-xs text-amber-300">The model was unsure of the contents.</span>}
            </div>
            <div className="space-y-2">
              {lines.map((l) => (
                <div
                  key={l.key}
                  className={`grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border p-2 sm:grid-cols-[auto_2fr_1.3fr_4rem_1fr_auto_auto] ${
                    l.create ? "border-slate-800 bg-slate-800/40" : "border-slate-800 opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={l.create}
                    onChange={(e) => setLine(l.key, { create: e.target.checked })}
                    title={l.create ? `Add as a new ${terms.item.singular.toLowerCase()}` : "Record only (already inside)"}
                    aria-label="Add as a new item"
                    className="h-4 w-4 accent-sky-600"
                  />
                  <input value={l.name} onChange={(e) => setLine(l.key, { name: e.target.value })} placeholder="What (dinner plates)" aria-label="Name" maxLength={120} className={CELL} />
                  <button type="button" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label="Remove line" className="text-slate-500 hover:text-red-400 sm:order-last">
                    <CloseIcon className="h-4 w-4" />
                  </button>
                  {/* A second row on a phone; the same row as the name on a wider screen. */}
                  <div className="col-span-3 flex flex-wrap items-center gap-2 sm:contents">
                    <input
                      value={l.category}
                      onChange={(e) => setLine(l.key, { category: e.target.value })}
                      placeholder="Category"
                      aria-label="Category"
                      list="condition-categories"
                      maxLength={60}
                      className={`${CELL_BASE} min-w-32 flex-1 sm:w-full`}
                    />
                    <input
                      type="number"
                      min={1}
                      max={9999}
                      value={l.qty}
                      onChange={(e) => setLine(l.key, { qty: Number(e.target.value) })}
                      aria-label="Quantity"
                      className={`${CELL_BASE} w-16 sm:w-full`}
                    />
                    <select
                      value={l.condition ?? ""}
                      onChange={(e) => setLine(l.key, { condition: (e.target.value || null) as ConditionRating | null })}
                      aria-label="Condition"
                      className={`${CELL_BASE} sm:w-full`}
                    >
                      <option value="">Condition</option>
                      {RATINGS.map((r) => (
                        <option key={r} value={r}>
                          {RATING_LABEL[r]}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-xs text-slate-300">
                      <input type="checkbox" checked={l.fragile} onChange={(e) => setLine(l.key, { fragile: e.target.checked })} className="h-4 w-4 accent-amber-500" />
                      Fragile
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <datalist id="condition-categories">
              {(settings?.categories ?? []).map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <button type="button" onClick={() => setLines((ls) => [...ls, blankLine()])} className="mt-2 rounded-lg border border-dashed border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
              Add a line
            </button>
          </div>

          {container.locationId && (
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={inherit} onChange={(e) => setInherit(e.target.checked)} className="h-4 w-4 accent-sky-600" />
              Record the new {itemWord} at {container.locationName ?? `the container's ${terms.location.singular.toLowerCase()}`}
            </label>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {busy ? "Saving…" : creating ? `Save and add ${creating} ${creating === 1 ? terms.item.singular.toLowerCase() : itemWord}` : "Save"}
            </button>
            <button type="button" onClick={() => setStep("photos")} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">
              Back to photos
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
