import { useEffect, useRef, useState } from "react";
import { listAttachments, uploadAttachment, type Attachment } from "../media-ai-core";
import { clock, errorMessage } from "./format";

const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";

export type VideoOwner = { ownerType: "item" | "unit"; ownerId: string };

/**
 * Record a teardown video with the camera, pick one from the library (where
 * a file AirDropped or shared by another crew member lands), or reuse a video
 * already attached to the record. Uploads go through the shared attachment
 * store with stage "teardown", so the video also shows in the record's files.
 */
export function VideoPicker({
  owners,
  onPicked,
  disabled = false,
}: {
  /** Where an upload goes; existing videos are offered from all of them. */
  owners: VideoOwner[];
  onPicked: (video: Attachment) => void;
  disabled?: boolean;
}) {
  const [existing, setExisting] = useState<Attachment[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const target = owners[0];
  const ownersKey = owners.map((o) => `${o.ownerType}:${o.ownerId}`).join(",");

  useEffect(() => {
    let live = true;
    Promise.all(
      ownersKey
        .split(",")
        .filter(Boolean)
        .map((key) => {
          const [ownerType, ownerId] = key.split(":") as [string, string];
          return listAttachments(ownerType, ownerId, { kind: ["video", "audio"] }).catch(() => [] as Attachment[]);
        }),
    ).then((lists) => {
      if (live) setExisting(lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
    return () => {
      live = false;
    };
  }, [ownersKey]);

  // Closing the dialog cancels an upload still going.
  useEffect(() => () => abort.current?.abort(), []);

  const upload = async (file: File | undefined) => {
    if (!file || !target) return;
    const kind = file.type.startsWith("audio/") ? "audio" : "video";
    if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
      setError("Pick a video, or an audio recording of the narration.");
      return;
    }
    setError(null);
    setProgress(0);
    abort.current = new AbortController();
    try {
      const saved = await uploadAttachment(file, {
        ...target,
        kind,
        stage: "teardown",
        onProgress: setProgress,
        signal: abort.current.signal,
      });
      onPicked(saved);
    } catch (err) {
      setError(errorMessage(err, "The upload failed."));
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const busy = disabled || progress !== null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className={`${BTN} cursor-pointer bg-sky-700/20 ${busy ? "pointer-events-none opacity-50" : ""}`}>
          Record a video
          <input
            type="file"
            accept="video/*"
            capture="environment"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              void upload(f);
            }}
          />
        </label>
        <label className={`${BTN} cursor-pointer ${busy ? "pointer-events-none opacity-50" : ""}`}>
          Choose from library
          <input
            type="file"
            accept="video/*,audio/*"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              void upload(f);
            }}
          />
        </label>
      </div>
      <p className="text-xs text-slate-500">Narrate while you work: say what you are removing, how many, and anything to watch for.</p>

      {progress !== null && (
        <div className="space-y-1" role="status">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Uploading… {Math.round(progress * 100)}%</span>
            <button type="button" className="text-slate-300 hover:underline" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-slate-800">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {existing.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Or use one already attached</p>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {existing.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPicked(a)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-800 disabled:opacity-50"
                >
                  <span className="truncate text-slate-200">
                    {a.caption || (typeof a.meta.filename === "string" ? a.meta.filename : a.kind === "audio" ? "Audio recording" : "Video")}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {[a.durationMs ? clock(a.durationMs / 1000) : null, new Date(a.createdAt).toLocaleDateString()].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
