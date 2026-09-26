import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertIcon, CameraIcon, CloseIcon, DocumentIcon } from "../../components/icons";
import { deleteAttachment, listAttachments, updateAttachment, uploadAttachment } from "./api";
import {
  KIND_LABEL,
  MicIcon,
  PaperclipIcon,
  PlayIcon,
  VideoIcon,
  acceptFor,
  errorMessage,
  formatBytes,
  formatDuration,
  kindForFile,
  probeMedia,
  stageLabel,
} from "./format";
import { Modal } from "./Modal";
import type { Attachment, AttachmentKind } from "./types";

const DEFAULT_KINDS: AttachmentKind[] = ["photo", "video", "audio", "document"];
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";

type Upload = { key: string; name: string; progress: number; error?: string };

export type AttachmentGalleryProps = {
  ownerType: string;
  ownerId: string;
  /** Lock the gallery to one stage: only that stage is shown, and uploads get it. */
  stage?: string;
  /** Stage chips to offer even before anything carries them, e.g. ["before", "after"]. */
  stages?: string[];
  /** Which kinds to show and accept. Signatures are left out unless asked for. */
  kinds?: AttachmentKind[];
  title?: string;
  readOnly?: boolean;
  /** Extra buttons in the viewer for one attachment, e.g. "Set as main photo". */
  actions?: (attachment: Attachment, helpers: { close: () => void; reload: () => Promise<void> }) => ReactNode;
  /** Extra buttons in the header, next to the upload buttons. */
  headerActions?: ReactNode;
  /** Change it to make the gallery reload, after saving an attachment elsewhere. */
  refreshKey?: unknown;
  onChange?: (attachments: Attachment[]) => void;
};

/**
 * Photos, video, audio and documents of one record: take a photo or a video
 * with the camera, pick files from the library, watch uploads progress, play
 * video in place, filter by stage, delete. Every feature that attaches files
 * to its records uses this rather than building its own.
 */
export function AttachmentGallery({
  ownerType,
  ownerId,
  stage,
  stages,
  kinds = DEFAULT_KINDS,
  title = "Photos and files",
  readOnly = false,
  actions,
  headerActions,
  refreshKey,
  onChange,
}: AttachmentGalleryProps) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [filter, setFilter] = useState<string | null>(stage ?? null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const kindsKey = kinds.join(",");

  const load = useCallback(async () => {
    try {
      setItems(await listAttachments(ownerType, ownerId, { kind: kindsKey.split(",") as AttachmentKind[], stage }));
    } catch (err) {
      setError(errorMessage(err, "Could not load the files."));
      setItems([]);
    }
  }, [ownerType, ownerId, kindsKey, stage]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Tell the parent after the list changes, never from inside a state update.
  useEffect(() => {
    if (items) onChangeRef.current?.(items);
  }, [items]);

  useEffect(() => setFilter(stage ?? null), [stage]);

  const stageOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const s of stages ?? []) seen.add(s.toLowerCase());
    for (const a of items ?? []) if (a.stage) seen.add(a.stage);
    return [...seen];
  }, [stages, items]);

  const visible = (items ?? []).filter((a) => !filter || a.stage === filter);
  const uploadStage = stage ?? filter ?? null;

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const kind = kindForFile(file, kinds);
      if (!kind) {
        setUploads((u) => [...u, { key, name: file.name, progress: 0, error: "That type of file is not accepted here." }]);
        continue;
      }
      setUploads((u) => [...u, { key, name: file.name || KIND_LABEL[kind], progress: 0 }]);
      try {
        const media = await probeMedia(file);
        const saved = await uploadAttachment(file, {
          ownerType,
          ownerId,
          kind,
          stage: uploadStage,
          ...media,
          onProgress: (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))),
        });
        setUploads((u) => u.filter((x) => x.key !== key));
        setItems((prev) => [...(prev ?? []), saved]);
      } catch (err) {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: errorMessage(err, "Upload failed.") } : x)));
      }
    }
  };

  const remove = async (a: Attachment) => {
    if (!confirm(`Delete this ${KIND_LABEL[a.kind].toLowerCase()}? This cannot be undone.`)) return;
    try {
      await deleteAttachment(a.id);
      setViewing(null);
      setItems((prev) => (prev ?? []).filter((x) => x.id !== a.id));
    } catch (err) {
      setError(errorMessage(err, "Could not delete it."));
    }
  };

  const saveCaption = async (a: Attachment, caption: string) => {
    const updated = await updateAttachment(a.id, { caption: caption.trim() || null });
    setItems((prev) => (prev ?? []).map((x) => (x.id === a.id ? updated : x)));
    setViewing(updated);
  };

  const picker = (label: string, icon: ReactNode, accept: string, capture?: "environment") => (
    <label className={`${BTN} cursor-pointer`}>
      {icon}
      {label}
      <input
        type="file"
        accept={accept}
        capture={capture}
        multiple={!capture}
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
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          {title}
          {items && items.length > 0 && <span className="ml-1 text-slate-500">({items.length})</span>}
        </h2>
        <div className="flex flex-wrap gap-2">
          {headerActions}
          {!readOnly && kinds.includes("photo") && picker("Take photo", <CameraIcon className="h-4 w-4" />, "image/*", "environment")}
          {!readOnly && kinds.includes("video") && picker("Record video", <VideoIcon className="h-4 w-4" />, "video/*", "environment")}
          {!readOnly && picker("Add files", <PaperclipIcon className="h-4 w-4" />, acceptFor(kinds))}
        </div>
      </div>

      {!stage && stageOptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by stage">
          {[null, ...stageOptions].map((s) => (
            <button
              key={s ?? "all"}
              type="button"
              onClick={() => setFilter(s)}
              aria-pressed={filter === s}
              className={`rounded-full px-3 py-1 text-xs ${
                filter === s ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {s ? stageLabel(s) : "All"}
            </button>
          ))}
        </div>
      )}

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
                  <span className="text-xs text-slate-400">{Math.round(u.progress * 100)}%</span>
                )}
              </div>
              {u.error ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-red-300">
                  <AlertIcon className="h-3.5 w-3.5" />
                  {u.error}
                </p>
              ) : (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-700">
                  <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {items === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : visible.length === 0 && uploads.length === 0 ? (
        <p className="text-sm text-slate-500">
          {filter ? `Nothing marked ${stageLabel(filter).toLowerCase()} yet.` : "No photos or files yet."}
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
          {visible.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setViewing(a)}
                title={a.caption ?? KIND_LABEL[a.kind]}
                className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-800 text-slate-400 hover:border-sky-600"
              >
                <Tile attachment={a} />
                {a.stage && (
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white">
                    {stageLabel(a.stage)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {viewing && (
        <Viewer
          attachment={viewing}
          readOnly={readOnly}
          onClose={() => setViewing(null)}
          onDelete={() => void remove(viewing)}
          onCaption={(c) => saveCaption(viewing, c)}
          extra={actions?.(viewing, { close: () => setViewing(null), reload: load })}
        />
      )}
    </section>
  );
}

function Tile({ attachment: a }: { attachment: Attachment }) {
  const [broken, setBroken] = useState(false);
  if ((a.kind === "photo" || a.kind === "signature" || a.mime.startsWith("image/")) && a.thumbUrl && !broken) {
    return (
      <img
        src={a.thumbUrl}
        alt={a.caption ?? "Photo"}
        loading="lazy"
        onError={() => setBroken(true)}
        className={`h-full w-full ${a.kind === "signature" ? "bg-white object-contain" : "object-cover"}`}
      />
    );
  }
  const name = typeof a.meta.filename === "string" ? a.meta.filename : a.caption;
  return (
    <span className="flex flex-col items-center gap-1 px-1 text-center">
      {a.kind === "video" ? (
        <PlayIcon className="h-7 w-7 text-slate-200" />
      ) : a.kind === "audio" ? (
        <MicIcon className="h-7 w-7" />
      ) : (
        <DocumentIcon className="h-7 w-7" />
      )}
      <span className="line-clamp-2 break-all text-[11px] leading-tight">
        {a.durationMs ? formatDuration(a.durationMs) : name ?? KIND_LABEL[a.kind]}
      </span>
    </span>
  );
}

function Viewer({
  attachment: a,
  readOnly,
  onClose,
  onDelete,
  onCaption,
  extra,
}: {
  attachment: Attachment;
  readOnly: boolean;
  onClose: () => void;
  onDelete: () => void;
  onCaption: (caption: string) => Promise<void>;
  extra?: ReactNode;
}) {
  const [caption, setCaption] = useState(a.caption ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setCaption(a.caption ?? ""), [a]);
  const name = typeof a.meta.filename === "string" ? a.meta.filename : null;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onCaption(caption);
    } catch (e) {
      setErr(errorMessage(e, "Could not save the caption."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={a.caption || name || KIND_LABEL[a.kind]} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex justify-center rounded-lg bg-black/40">
          {a.kind === "video" || a.mime.startsWith("video/") ? (
            <video src={a.url} controls playsInline preload="metadata" className="max-h-[65vh] w-full" />
          ) : a.kind === "audio" || a.mime.startsWith("audio/") ? (
            <audio src={a.url} controls preload="metadata" className="my-6 w-full px-4" />
          ) : a.mime.startsWith("image/") ? (
            <img
              src={a.url}
              alt={a.caption ?? "Photo"}
              className={`max-h-[65vh] object-contain ${a.kind === "signature" ? "bg-white" : ""}`}
            />
          ) : (
            <a href={a.url} target="_blank" rel="noreferrer" className="my-8 flex flex-col items-center gap-2 text-sky-400 hover:underline">
              <DocumentIcon className="h-10 w-10" />
              Open {name ?? "document"}
            </a>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase text-slate-500">Kind</dt>
            <dd className="text-slate-200">{KIND_LABEL[a.kind]}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Stage</dt>
            <dd className="text-slate-200">{a.stage ? stageLabel(a.stage) : "None"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Added</dt>
            <dd className="text-slate-200">{new Date(a.createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-500">Size</dt>
            <dd className="text-slate-200">
              {formatBytes(a.sizeBytes)}
              {a.width && a.height ? ` · ${a.width}×${a.height}` : ""}
              {a.durationMs ? ` · ${formatDuration(a.durationMs)}` : ""}
            </dd>
          </div>
        </dl>

        {!readOnly ? (
          <div className="flex gap-2">
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Add a caption"
              aria-label="Caption"
              maxLength={500}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || caption === (a.caption ?? "")}
              className="rounded-lg bg-slate-700 px-4 text-sm text-slate-100 hover:bg-slate-600 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        ) : (
          a.caption && <p className="text-sm text-slate-300">{a.caption}</p>
        )}
        {err && <p className="text-sm text-red-400">{err}</p>}

        <div className="flex flex-wrap gap-2">
          {extra}
          <a href={a.url} download={name ?? undefined} className={BTN}>
            Download
          </a>
          {!readOnly && a.kind !== "signature" && (
            <button type="button" onClick={onDelete} className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950">
              Delete
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
