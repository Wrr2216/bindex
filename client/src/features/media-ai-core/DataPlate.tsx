import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertIcon } from "../../components/icons";
import { useFeatures } from "../../config/useConfig";
import type { IdentifierType, ItemDetail } from "../../types";
import { applyDataPlate, readDataPlate, updateAttachment, uploadAttachment } from "./api";
import { ScanTextIcon, errorMessage } from "./format";
import { Modal } from "./Modal";
import type { DataPlateAccepted, DataPlateField, DataPlateReading, DataPlateResult } from "./types";
import { useAiAvailability } from "./useAiAvailability";

/**
 * Serial number and data-plate capture. Photograph a label, the vision model
 * reads it, and the person checks every field before anything is saved:
 * low-confidence readings are highlighted and identifiers already on another
 * record are flagged and left unticked.
 */

export type LabelTarget = { ownerType: "item" | "unit"; ownerId: string; label: string };

/** What the label says beyond the savable fields; kept with the label photo. */
export type LabelDetails = {
  manufactureDate: string | null;
  ratings: DataPlateReading["ratings"];
  otherIdentifiers: DataPlateReading["otherIdentifiers"];
  rawText: string;
};

export type LabelReview = {
  /** Where to save, when the review offered a choice. */
  target: LabelTarget | null;
  /** The ticked savable fields, as the person left them. */
  fields: DataPlateAccepted;
  details: LabelDetails;
  photo: Blob;
};

const SAVABLE: { key: keyof DataPlateAccepted & DataPlateField; label: string; mono?: boolean }[] = [
  { key: "brand", label: "Brand" },
  { key: "model", label: "Model" },
  { key: "serial", label: "Serial number", mono: true },
  { key: "partNumber", label: "Part number", mono: true },
  { key: "assetTag", label: "Asset tag", mono: true },
  { key: "mac", label: "MAC address", mono: true },
];

const RATINGS: { key: keyof DataPlateReading["ratings"]; label: string }[] = [
  { key: "voltage", label: "Voltage" },
  { key: "amperage", label: "Current" },
  { key: "wattage", label: "Power" },
  { key: "frequency", label: "Frequency" },
];

const INPUT =
  "w-full rounded-lg border bg-slate-800 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";

/** Whether reading labels is on and possible here. */
export function useLabelCaptureEnabled(): boolean {
  const features = useFeatures();
  const ai = useAiAvailability();
  return features.aiCapture && ai.vision;
}

/**
 * The "Read from label" button and the whole flow behind it. Renders nothing
 * when the feature is off or no vision model is configured. `onAccept` may
 * throw; its message is shown in the review, which stays open to fix.
 */
export function ReadFromLabel({
  owner,
  targets,
  onAccept,
  saveLabel = "Save",
  buttonLabel = "Read from label",
  className,
}: {
  /** The record being filled in, so its own identifiers do not count as taken. */
  owner?: { ownerType: "item" | "unit"; ownerId: string };
  /** Offer a choice of where to save (the item or one of its units). */
  targets?: LabelTarget[];
  onAccept: (review: LabelReview) => Promise<void> | void;
  saveLabel?: string;
  buttonLabel?: string;
  className?: string;
}) {
  const enabled = useLabelCaptureEnabled();
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [result, setResult] = useState<DataPlateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!enabled) return null;

  const read = async (file: File) => {
    setPhoto(file);
    setResult(null);
    setError(null);
    try {
      setResult(await readDataPlate(file, owner));
    } catch (err) {
      setError(errorMessage(err, "The label could not be read."));
    }
  };

  const close = () => {
    setPhoto(null);
    setResult(null);
    setError(null);
  };

  const accept = async (review: LabelReview) => {
    setBusy(true);
    setError(null);
    try {
      await onAccept(review);
      close();
    } catch (err) {
      setError(errorMessage(err, "Could not save. Check the fields and try again."));
    } finally {
      setBusy(false);
    }
  };

  const camera = (label: ReactNode, cls: string) => (
    <label className={`cursor-pointer ${cls}`}>
      {label}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void read(f);
        }}
      />
    </label>
  );

  return (
    <>
      {camera(
        <>
          <ScanTextIcon className="h-4 w-4" />
          {buttonLabel}
        </>,
        className ??
          "inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800",
      )}
      {photo && (
        <Modal title="Read from label" onClose={close} wide>
          {!result && !error ? (
            <Reading photo={photo} />
          ) : result?.found && result.reading ? (
            <Review
              photo={photo}
              result={result}
              targets={targets}
              busy={busy}
              error={error}
              saveLabel={saveLabel}
              onCancel={close}
              onAccept={(r) => void accept(r)}
              retake={camera("Retake photo", "rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800")}
            />
          ) : (
            <div className="space-y-4">
              <PhotoPreview photo={photo} />
              <p className="flex items-start gap-2 text-sm text-amber-300">
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
                {error ??
                  result?.message ??
                  (result?.available === false
                    ? "Reading labels is not set up on this server."
                    : "No label could be read. Try again closer, straight on, and without glare.")}
              </p>
              <div className="flex gap-2">
                {camera("Retake photo", "rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500")}
                <button type="button" onClick={close} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function PhotoPreview({ photo, className = "max-h-48" }: { photo: Blob; className?: string }) {
  const url = useMemo(() => URL.createObjectURL(photo), [photo]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt="Label photo" className={`mx-auto rounded-lg object-contain ${className}`} />;
}

function Reading({ photo }: { photo: Blob }) {
  return (
    <div className="space-y-4 text-center">
      <PhotoPreview photo={photo} />
      <p className="animate-pulse text-sm text-sky-300">Reading the label…</p>
    </div>
  );
}

type Draft = Record<keyof DataPlateAccepted, string>;

function Review({
  photo,
  result,
  targets,
  busy,
  error,
  saveLabel,
  onCancel,
  onAccept,
  retake,
}: {
  photo: Blob;
  result: DataPlateResult;
  targets?: LabelTarget[];
  busy: boolean;
  error: string | null;
  saveLabel: string;
  onCancel: () => void;
  onAccept: (r: LabelReview) => void;
  retake: ReactNode;
}) {
  const reading = result.reading!;
  const taken = result.taken;
  const takenFor = (key: keyof DataPlateAccepted) =>
    key === "serial" ? taken?.serial : key === "mac" ? taken?.mac : key === "assetTag" ? taken?.assetTag : null;

  const [draft, setDraft] = useState<Draft>(() => ({
    brand: reading.brand ?? "",
    model: reading.model ?? "",
    serial: reading.serial ?? "",
    partNumber: reading.partNumber ?? "",
    assetTag: reading.assetTag ?? "",
    mac: reading.mac ?? "",
  }));
  const [ticked, setTicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SAVABLE.map((f) => [f.key, Boolean(reading[f.key]) && !takenFor(f.key)])),
  );
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<LabelDetails>({
    manufactureDate: reading.manufactureDate,
    ratings: { ...reading.ratings },
    otherIdentifiers: reading.otherIdentifiers,
    rawText: reading.rawText,
  });
  const [target, setTarget] = useState<LabelTarget | null>(targets?.[0] ?? null);

  const low = (key: DataPlateField, value: string) =>
    Boolean(value) && !edited.has(key) && (reading.confidence[key] ?? 0) < result.lowConfidence;

  const set = (key: keyof DataPlateAccepted, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setEdited((s) => new Set(s).add(key));
    setTicked((t) => ({ ...t, [key]: Boolean(value.trim()) }));
  };

  const submit = () => {
    const fields: DataPlateAccepted = {};
    for (const f of SAVABLE) {
      const v = draft[f.key].trim();
      if (ticked[f.key] && v) fields[f.key] = v;
    }
    onAccept({ target, fields, details, photo });
  };

  const anyTicked = SAVABLE.some((f) => ticked[f.key] && draft[f.key].trim());
  const lowCount = SAVABLE.filter((f) => ticked[f.key] && low(f.key, draft[f.key])).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <PhotoPreview photo={photo} className="max-h-40 sm:max-h-56 sm:max-w-[40%]" />
        <div className="flex-1 space-y-2 text-sm text-slate-300">
          <p>Check every field against the label. Only ticked fields are saved.</p>
          {lowCount > 0 && (
            <p className="flex items-start gap-1.5 text-amber-300">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
              {lowCount === 1 ? "One field was hard to read." : `${lowCount} fields were hard to read.`} They are
              marked below.
            </p>
          )}
          {targets && targets.length > 1 && (
            <label className="block">
              <span className="text-xs uppercase tracking-wide text-slate-400">Save to</span>
              <select
                className={`${INPUT} mt-1 border-slate-700`}
                value={target?.ownerId ?? ""}
                onChange={(e) => setTarget(targets.find((t) => t.ownerId === e.target.value) ?? null)}
              >
                {targets.map((t) => (
                  <option key={t.ownerId} value={t.ownerId}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <ul className="space-y-2">
        {SAVABLE.map((f) => {
          const value = draft[f.key];
          const isLow = low(f.key, value);
          // Only while the value is still the one found elsewhere.
          const takenBy = value.trim() === (reading[f.key] ?? "") ? takenFor(f.key) : null;
          const id = `plate-${f.key}`;
          return (
            <li key={f.key} className="grid grid-cols-[auto_1fr] items-start gap-x-2">
              <input
                type="checkbox"
                aria-label={`Save ${f.label.toLowerCase()}`}
                checked={Boolean(ticked[f.key])}
                disabled={!value.trim()}
                onChange={(e) => setTicked((t) => ({ ...t, [f.key]: e.target.checked }))}
                className="mt-7 h-4 w-4 accent-sky-600"
              />
              <div>
                <label htmlFor={id} className="text-xs uppercase tracking-wide text-slate-400">
                  {f.label}
                  {f.key === "serial" && target?.ownerType === "unit" ? " (on the unit)" : ""}
                </label>
                <input
                  id={id}
                  value={value}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder="Not read"
                  className={`${INPUT} mt-1 ${f.mono ? "font-mono" : ""} ${
                    takenBy ? "border-red-700" : isLow ? "border-amber-500 bg-amber-950/30" : "border-slate-700"
                  }`}
                />
                {takenBy ? (
                  <p className="mt-1 text-xs text-red-300">Already on “{takenBy.itemName}”. Correct it or leave it unticked.</p>
                ) : isLow ? (
                  <p className="mt-1 text-xs text-amber-300">Hard to read. Check it against the label.</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <details className="rounded-lg border border-slate-800 p-3 text-sm" open={Boolean(details.manufactureDate || Object.values(details.ratings).some(Boolean))}>
        <summary className="cursor-pointer text-slate-300">More from the label (kept with the photo)</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs uppercase tracking-wide text-slate-400">Manufactured</span>
            <input
              value={details.manufactureDate ?? ""}
              onChange={(e) => setDetails((d) => ({ ...d, manufactureDate: e.target.value || null }))}
              className={`${INPUT} mt-1 border-slate-700`}
            />
          </label>
          {RATINGS.map((r) => (
            <label key={r.key} className="block">
              <span className="text-xs uppercase tracking-wide text-slate-400">{r.label}</span>
              <input
                value={details.ratings[r.key] ?? ""}
                onChange={(e) => setDetails((d) => ({ ...d, ratings: { ...d.ratings, [r.key]: e.target.value || null } }))}
                className={`${INPUT} mt-1 border-slate-700`}
              />
            </label>
          ))}
        </div>
        {details.otherIdentifiers.length > 0 && (
          <ul className="mt-3 space-y-1 text-slate-300">
            {details.otherIdentifiers.map((o, i) => (
              <li key={i}>
                <span className="text-xs uppercase text-slate-500">{o.label}</span> <span className="font-mono">{o.value}</span>
              </li>
            ))}
          </ul>
        )}
        {details.rawText && (
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-xs text-slate-400">
            {details.rawText}
          </pre>
        )}
      </details>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !anyTicked}
          className="flex-1 rounded-lg bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : saveLabel}
        </button>
        {retake}
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Keep the label photo as an attachment with stage "label", carrying the full
 * reading in its meta. Best effort: the fields are already saved, so a failed
 * upload is reported but not fatal.
 */
export async function saveLabelPhoto(review: LabelReview, owner: { ownerType: "item" | "unit"; ownerId: string }) {
  const saved = await uploadAttachment(review.photo, {
    ...owner,
    kind: "photo",
    stage: "label",
    caption: "Label",
  });
  return updateAttachment(saved.id, {
    meta: {
      source: "data-plate",
      dataPlate: { ...review.fields, ...review.details, rawText: review.details.rawText.slice(0, 4000) },
    },
  });
}

/** Save a review straight onto an item or unit (item detail page). */
export async function applyLabelReview(review: LabelReview, fallback: LabelTarget): Promise<ItemDetail> {
  const target = review.target ?? fallback;
  const owner = { ownerType: target.ownerType, ownerId: target.ownerId };
  const detail = await applyDataPlate(owner, review.fields);
  await saveLabelPhoto(review, owner).catch((err) => console.warn("Label photo not saved", err));
  return detail;
}

const IDENTIFIER_TYPES: [keyof DataPlateAccepted, IdentifierType][] = [
  ["serial", "serial"],
  ["mac", "mac"],
  ["assetTag", "asset_tag"],
  ["partNumber", "sku"],
];

/**
 * For the item form: "Read from label" fills brand and model into the form at
 * once, and holds the identifiers and the photo until the form is saved, so
 * nothing is written unless the person saves the item.
 */
export function useLabelCapture({
  item,
  onFill,
}: {
  item?: ItemDetail;
  onFill: (fields: { brand?: string; model?: string }) => void;
}) {
  const [pending, setPending] = useState<LabelReview | null>(null);
  const enabled = useLabelCaptureEnabled();

  const control = enabled ? (
    <div className="space-y-2">
      <ReadFromLabel
        owner={item ? { ownerType: "item", ownerId: item.id } : undefined}
        saveLabel="Use these values"
        onAccept={(review) => {
          onFill({ brand: review.fields.brand ?? undefined, model: review.fields.model ?? undefined });
          setPending(review);
        }}
      />
      {pending && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-800/60 px-3 py-2 text-xs text-slate-300">
          <span>From the label, saved with this form:</span>
          {IDENTIFIER_TYPES.filter(([k]) => pending.fields[k]).map(([k, type]) => (
            <span key={k} className="rounded bg-slate-900 px-1.5 py-0.5 font-mono">
              {type}: {pending.fields[k]}
            </span>
          ))}
          <span className="rounded bg-slate-900 px-1.5 py-0.5">label photo</span>
          <button type="button" onClick={() => setPending(null)} className="ml-auto text-sky-400 hover:underline">
            Discard
          </button>
        </div>
      )}
    </div>
  ) : null;

  /** The identifiers to create an item with, merged into `base` without repeating a value. */
  const withIdentifiers = <T extends { type: IdentifierType; value: string }>(base: T[]) => {
    const out: { type: IdentifierType; value: string }[] = [...base];
    if (!pending) return out;
    for (const [key, type] of IDENTIFIER_TYPES) {
      const value = pending.fields[key]?.trim();
      if (value && !out.some((i) => i.value.trim() === value)) out.push({ type, value });
    }
    return out;
  };

  /**
   * After the form saved: add the identifiers (when editing; a new item got
   * them on creation) and keep the label photo. Returns the fresh item.
   */
  const commit = async (saved: ItemDetail, opts: { created: boolean }): Promise<ItemDetail> => {
    if (!pending) return saved;
    const owner = { ownerType: "item" as const, ownerId: saved.id };
    let result = saved;
    if (!opts.created) {
      const { serial, mac, assetTag, partNumber } = pending.fields;
      if (serial || mac || assetTag || partNumber) result = await applyDataPlate(owner, { serial, mac, assetTag, partNumber });
    }
    await saveLabelPhoto(pending, owner).catch((err) => console.warn("Label photo not saved", err));
    setPending(null);
    return result;
  };

  return { control, withIdentifiers, commit, pending };
}
