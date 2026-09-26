import { useState } from "react";
import { CameraIcon, CheckIcon } from "../../components/icons";
import { listAttachments, uploadAttachment } from "../media-ai-core";
import { errorMessage } from "./vocab";

export type PickedPhoto = { id: string; url: string; thumbUrl: string | null };

const BTN =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800";

/**
 * Photos for one report or capture. Taking one uploads it at once as an
 * attachment of the record (with the given stage), so it is safe on the
 * server even if the rest of the form is abandoned, and shows in the record's
 * gallery. Tapping a photo leaves it out of this report.
 */
export function PhotoPicker({
  ownerType,
  ownerId,
  stage,
  photos,
  onPhotos,
  selected,
  onSelected,
  max = 6,
  hint,
}: {
  ownerType: "item" | "unit";
  ownerId: string;
  stage: string;
  /** Photos on offer; the parent keeps them so they survive re-renders. */
  photos: PickedPhoto[];
  onPhotos: (photos: PickedPhoto[]) => void;
  selected: string[];
  onSelected: (ids: string[]) => void;
  max?: number;
  hint?: string;
}) {
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    let list = photos;
    let chosen = selected;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        setError("Only photos can be used here.");
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const a = await uploadAttachment(file, { ownerType, ownerId, kind: "photo", stage });
        list = [...list, { id: a.id, url: a.url, thumbUrl: a.thumbUrl }];
        if (chosen.length < max) chosen = [...chosen, a.id];
        onPhotos(list);
        onSelected(chosen);
      } catch (err) {
        setError(errorMessage(err, "The photo did not upload."));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const earlier = async () => {
    setLoadingEarlier(true);
    try {
      const found = await listAttachments(ownerType, ownerId, { kind: ["photo"] });
      const known = new Set(photos.map((p) => p.id));
      onPhotos([...photos, ...found.filter((a) => !known.has(a.id)).map((a) => ({ id: a.id, url: a.url, thumbUrl: a.thumbUrl }))]);
    } catch (err) {
      setError(errorMessage(err, "Could not load earlier photos."));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const toggle = (id: string) => {
    if (selected.includes(id)) onSelected(selected.filter((x) => x !== id));
    else if (selected.length < max) onSelected([...selected, id]);
    else setError(`Use at most ${max} photos.`);
  };

  const picker = (label: string, capture: boolean) => (
    <label className={BTN}>
      <CameraIcon className="h-4 w-4" />
      {label}
      <input
        type="file"
        accept="image/*"
        capture={capture ? "environment" : undefined}
        multiple={!capture}
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          void add(files).finally(() => {
            e.target.value = "";
          });
        }}
      />
    </label>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {picker("Take photo", true)}
        {picker("From library", false)}
        <button type="button" onClick={() => void earlier()} disabled={loadingEarlier} className={`${BTN} disabled:opacity-50`}>
          {loadingEarlier ? "Loading…" : "Earlier photos"}
        </button>
        {uploading > 0 && <span className="animate-pulse text-xs text-sky-300">Uploading {uploading}…</span>}
      </div>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      {photos.length > 0 && (
        <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {photos.map((p) => {
            const on = selected.includes(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  aria-pressed={on}
                  title={on ? "Included. Tap to leave out." : "Left out. Tap to include."}
                  className={`relative block aspect-square w-full overflow-hidden rounded-lg border-2 ${
                    on ? "border-sky-500" : "border-slate-800 opacity-50"
                  }`}
                >
                  <img src={p.thumbUrl ?? p.url} alt="" className="h-full w-full object-cover" />
                  {on && (
                    <span className="absolute right-1 top-1 rounded-full bg-sky-600 p-0.5 text-white">
                      <CheckIcon className="h-3 w-3" />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
