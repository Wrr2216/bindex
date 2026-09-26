import { useEffect, useState } from "react";
import { CameraIcon } from "../../components/icons";
import { listAttachments, uploadAttachment } from "../media-ai-core/api";
import { Modal } from "../media-ai-core/Modal";
import type { Attachment } from "../media-ai-core/types";
import { valuationApi } from "./api";
import { BTN, BTN_PRIMARY, EstimateNote, FIELD, LABEL, Pill, centsToInput, errorText, parseMoneyInput, useMoneyExact } from "./format";
import type { EstimateResult, ValuationEstimate } from "./types";

type Props = {
  item: { id: string; name: string; brand: string | null; model: string | null };
  /** Value one unit rather than the item. */
  unit: { id: string; label: string } | null;
  crossCheckAvailable: boolean;
  onSaved: () => void;
  onClose: () => void;
};

const TEXT_FIELDS: { key: keyof ValuationEstimate; label: string; wide?: boolean }[] = [
  { key: "brand", label: "Brand" },
  { key: "model", label: "Model" },
  { key: "category", label: "Category" },
  { key: "condition", label: "Condition" },
  { key: "materials", label: "Materials", wide: true },
  { key: "conditionNotes", label: "Wear or damage", wide: true },
  { key: "description", label: "Description", wide: true },
];

/**
 * Scan, confirm, save: photograph the item (or pick photos already on it), let
 * the vision model identify it and suggest a value range, then correct
 * whatever it got wrong and save the value. The estimate and the photos are
 * kept with the valuation as its evidence.
 */
export function EstimateDialog({ item, unit, crossCheckAvailable, onSaved, onClose }: Props) {
  const money = useMoneyExact();
  const owner = unit ? { ownerType: "unit", ownerId: unit.id } : { ownerType: "item", ownerId: item.id };
  const [photos, setPhotos] = useState<Attachment[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [draft, setDraft] = useState<ValuationEstimate | null>(null);
  const [value, setValue] = useState("");
  const [source, setSource] = useState<"ai" | "web">("ai");
  const [applyIdentity, setApplyIdentity] = useState(true);
  const [crossCheck, setCrossCheck] = useState(crossCheckAvailable);

  useEffect(() => {
    listAttachments(owner.ownerType, owner.ownerId, { kind: ["photo"] })
      .then((list) => {
        const images = list.filter((a) => a.thumbUrl);
        setPhotos(images);
        // The newest few are most likely the ones just taken for this.
        setPicked(images.slice(-3).map((a) => a.id));
      })
      .catch(() => setPhotos([]));
  }, [owner.ownerType, owner.ownerId]);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setUploading((n) => n + files.length);
    for (const file of Array.from(files)) {
      try {
        const a = await uploadAttachment(file, { ...owner, kind: "photo", stage: "valuation" });
        setPhotos((list) => [...(list ?? []), a]);
        setPicked((p) => [...p.filter((id) => id !== a.id), a.id].slice(-6));
      } catch (err) {
        setError(errorText(err, "The photo did not upload."));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const estimate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await valuationApi.estimate(item.id, { unitId: unit?.id ?? null, attachmentIds: picked, crossCheck });
      setResult(r);
      if (r.estimate) {
        setDraft(r.estimate);
        setValue(centsToInput(r.estimate.estimatedValue?.suggestedCents ?? null));
        setSource("ai");
      }
    } catch (err) {
      setError(errorText(err, "The estimate did not come back. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!result || !draft) return;
    const cents = parseMoneyInput(value);
    if (cents === null || cents < 0) {
      setError("Enter the value to record.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const range = draft.estimatedValue;
      await valuationApi.recordValuation(item.id, {
        unitId: unit?.id ?? null,
        valueCents: cents,
        source,
        basis:
          source === "web"
            ? `Web price${result.webPrice?.retailer ? ` at ${result.webPrice.retailer}` : ""}, checked ${result.webPrice?.checkedAt.slice(0, 10) ?? ""}`
            : (range?.basis ?? "AI estimate from photos"),
        confidence: source === "ai" ? draft.confidence : null,
        lowCents: source === "ai" ? (range?.lowCents ?? null) : null,
        highCents: source === "ai" ? (range?.highCents ?? null) : null,
        details: {
          brand: draft.brand,
          model: draft.model,
          category: draft.category,
          materials: draft.materials,
          condition: draft.condition,
          conditionNotes: draft.conditionNotes,
          description: draft.description,
          estimate: result.estimate,
          webPrice: result.webPrice,
          attachmentIds: result.attachmentIds,
        },
        apply: !unit && applyIdentity ? { brand: draft.brand, model: draft.model } : undefined,
      });
      onSaved();
    } catch (err) {
      setError(errorText(err, "The value was not saved."));
    } finally {
      setBusy(false);
    }
  };

  const title = `Estimate value: ${unit ? `${item.name} (${unit.label})` : item.name}`;

  if (!result || !draft) {
    return (
      <Modal title={title} onClose={onClose} wide>
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            Photograph the whole item, and any label or maker's mark, in good light. Pick up to six photos.
          </p>
          <div className="flex flex-wrap gap-2">
            <label className={`${BTN_PRIMARY} cursor-pointer`}>
              <CameraIcon className="h-4 w-4" />
              Take photo
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
            </label>
            <label className={`${BTN} cursor-pointer`}>
              Choose photos
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
            </label>
            {uploading > 0 && <span className="self-center text-sm text-slate-400">Uploading {uploading}…</span>}
          </div>
          {photos === null ? (
            <p className="text-sm text-slate-500">Loading photos…</p>
          ) : photos.length === 0 ? (
            <p className="text-sm text-slate-500">No photos yet.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="group" aria-label="Photos to use">
              {photos.map((a) => {
                const on = picked.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPicked((p) => (on ? p.filter((x) => x !== a.id) : [...p, a.id].slice(-6)))}
                    className={`relative aspect-square overflow-hidden rounded-lg border-2 ${on ? "border-sky-500" : "border-transparent opacity-60"}`}
                  >
                    <img src={`${a.thumbUrl}?w=240`} alt={a.caption ?? "Photo"} className="h-full w-full object-cover" />
                    {on && <span className="absolute right-1 top-1 rounded bg-sky-600 px-1.5 text-xs text-white">Use</span>}
                  </button>
                );
              })}
            </div>
          )}
          {crossCheckAvailable && (
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={crossCheck} onChange={(e) => setCrossCheck(e.target.checked)} />
              Also look up the current web price
            </label>
          )}
          {result && !result.found && <p className="text-sm text-amber-300">{result.message ?? "No estimate could be made."}</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={estimate} disabled={busy || !picked.length || uploading > 0} className={`${BTN_PRIMARY} flex-1 justify-center py-2`}>
              {busy ? "Looking at the photos…" : `Estimate from ${picked.length} photo${picked.length === 1 ? "" : "s"}`}
            </button>
            <button type="button" onClick={onClose} className={BTN}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const range = draft.estimatedValue;
  const lowConfidence = draft.confidence < 0.6;
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {TEXT_FIELDS.map((f) => (
            <label key={f.key} className={f.wide ? "sm:col-span-2" : ""}>
              <span className={LABEL}>{f.label}</span>
              <input
                className={`${FIELD} mt-1`}
                value={(draft[f.key] as string | null) ?? ""}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value || null })}
              />
            </label>
          ))}
        </div>

        <div className="rounded-lg bg-slate-800/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-300">Estimated</span>
            <span className="text-lg font-semibold text-slate-100">
              {range ? `${money(range.lowCents, range.currency)} – ${money(range.highCents, range.currency)}` : "No value"}
            </span>
            <Pill tone={lowConfidence ? "warn" : "info"} title="How sure the model says it is, after checks">
              {Math.round(draft.confidence * 100)}% confident
            </Pill>
          </div>
          {range?.basis && <p className="mt-1 text-sm text-slate-400">{range.basis}</p>}
          {draft.currencyMismatch && (
            <p className="mt-1 text-sm text-amber-300">
              The estimate came back in {range?.currency}, not this instance's currency. Convert it before saving.
            </p>
          )}
          {lowConfidence && <p className="mt-1 text-sm text-amber-300">The model is unsure. Check the identification and the value carefully.</p>}
          {result.webPrice && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-300">
              {result.webPrice.found && result.webPrice.priceCents != null ? (
                <>
                  <span>
                    Web price {money(result.webPrice.priceCents, result.webPrice.currency)}
                    {result.webPrice.retailer ? ` at ${result.webPrice.retailer}` : ""}
                  </span>
                  {result.webPrice.url && (
                    <a href={result.webPrice.url} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                      listing
                    </a>
                  )}
                  <button
                    type="button"
                    className={BTN}
                    onClick={() => {
                      setValue(centsToInput(result.webPrice!.priceCents!));
                      setSource("web");
                    }}
                  >
                    Use web price
                  </button>
                </>
              ) : (
                <span className="text-slate-500">No web price found for comparison.</span>
              )}
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className={LABEL}>Value to record</span>
            <input
              className={`${FIELD} mt-1`}
              inputMode="decimal"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (source === "web") setSource("ai");
              }}
            />
          </label>
          {!unit && (draft.brand || draft.model) && (draft.brand !== item.brand || draft.model !== item.model) && (
            <label className="flex items-end gap-2 pb-2 text-sm text-slate-300">
              <input type="checkbox" checked={applyIdentity} onChange={(e) => setApplyIdentity(e.target.checked)} />
              Save this brand and model on the item
            </label>
          )}
        </div>

        <EstimateNote />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={save} disabled={busy} className={`${BTN_PRIMARY} flex-1 justify-center py-2`}>
            {busy ? "Saving…" : "Confirm value"}
          </button>
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setDraft(null);
            }}
            className={BTN}
          >
            Back to photos
          </button>
        </div>
      </div>
    </Modal>
  );
}
