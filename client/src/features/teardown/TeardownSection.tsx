import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFeatures, useTerms } from "../../config/useConfig";
import type { ItemDetail } from "../../types";
import { Modal, type Attachment } from "../media-ai-core";
import { teardownApi } from "./api";
import { STATUS_LABEL, errorMessage, isBusy } from "./format";
import type { GuideSummary, TeardownStatus } from "./types";
import { VideoPicker, type VideoOwner } from "./VideoPicker";

const unitName = (u: { label: string | null; serial: string | null; assetCode: string }) =>
  u.label?.trim() || u.serial?.trim() || u.assetCode;

export function StatusPill({ status, draftPending }: { status: GuideSummary["job"]["status"]; draftPending?: boolean }) {
  const tone =
    status === "failed"
      ? "bg-red-950 text-red-300"
      : isBusy(status)
        ? "bg-sky-950 text-sky-300"
        : draftPending
          ? "bg-amber-950 text-amber-300"
          : status === "done"
            ? "bg-emerald-950 text-emerald-400"
            : "bg-slate-800 text-slate-400";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${tone}`}>{draftPending && !isBusy(status) ? "To review" : STATUS_LABEL[status]}</span>
  );
}

/** Start a guide: pick whose it is, then record, choose or reuse a video (or none). */
export function NewGuideDialog({ item, onClose }: { item: ItemDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const features = useFeatures();
  const terms = useTerms();
  const [unitId, setUnitId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<TeardownStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const units = features.units ? item.units : [];

  useEffect(() => {
    teardownApi.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  const owners: VideoOwner[] = unitId
    ? [{ ownerType: "unit", ownerId: unitId }, { ownerType: "item", ownerId: item.id }]
    : [{ ownerType: "item", ownerId: item.id }];

  const create = async (video: Attachment | null) => {
    setSaving(true);
    setError(null);
    try {
      const guide = await teardownApi.create({
        itemId: item.id,
        unitId: unitId || null,
        title: title.trim() || null,
        videoAttachmentId: video?.id ?? null,
      });
      navigate(`/teardown/${guide.id}`);
    } catch (err) {
      setError(errorMessage(err, "Could not start the guide."));
      setSaving(false);
    }
  };

  return (
    <Modal title="New teardown guide" onClose={onClose}>
      <div className="space-y-4">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`${item.name} teardown`}
            maxLength={200}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
          />
        </label>
        {units.length > 0 && (
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Which one</span>
            <select
              value={unitId}
              onChange={(e) => setUnitId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100"
            >
              <option value="">The {terms.item.singular.toLowerCase()} as a whole</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  Unit: {unitName(u)}
                </option>
              ))}
            </select>
          </label>
        )}

        <VideoPicker owners={owners} onPicked={(v) => void create(v)} disabled={saving} />

        {status && !status.transcription && (
          <p className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
            Speech to text is not set up on this server, so the video is kept with the guide and the steps are written by hand. See
            docs/teardown.md to turn it on.
          </p>
        )}
        {status && status.transcription && !status.ffmpeg && (
          <p className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
            ffmpeg is not installed on the server: videos up to 24 MB are transcribed whole, and steps get no pictures.
          </p>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-slate-800 pt-3">
          <button type="button" onClick={() => void create(null)} disabled={saving} className="text-sm text-sky-400 hover:underline disabled:opacity-50">
            No video: write the steps by hand
          </button>
          {saving && <span className="text-sm text-slate-400">Starting…</span>}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * Teardown guides on the item page: each with its status and a way into its
 * video, plus a button to start one. Hidden when the feature is off.
 */
export function TeardownSection({ item }: { item: ItemDetail }) {
  const features = useFeatures();
  const [guides, setGuides] = useState<GuideSummary[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    teardownApi
      .list({ itemId: item.id })
      .then(setGuides)
      .catch(() => setGuides([]));
  }, [item.id]);

  useEffect(() => {
    if (features.teardown) load();
  }, [features.teardown, load]);

  if (!features.teardown || guides === null) return null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Teardown guides</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          New guide
        </button>
      </div>
      {guides.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          Film the teardown while you narrate it, and it becomes numbered steps and a parts list for putting it back together.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-800">
          {guides.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 py-2">
              <Link to={`/teardown/${g.id}`} className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sky-300 hover:underline">{g.title}</span>
                <span className="block text-xs text-slate-500">
                  {[
                    g.unitName ? `Unit ${g.unitName}` : null,
                    `${g.stepCount} step${g.stepCount === 1 ? "" : "s"}`,
                    `${g.partCount} part${g.partCount === 1 ? "" : "s"}`,
                    g.partCount && g.partsReassembled ? `${g.partsReassembled} refitted` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </Link>
              {g.videoAttachmentId && (
                <Link to={`/teardown/${g.id}#video`} className="shrink-0 text-xs text-sky-400 hover:underline">
                  View video
                </Link>
              )}
              <StatusPill status={g.job.status} draftPending={g.draftPending} />
            </li>
          ))}
        </ul>
      )}
      {creating && <NewGuideDialog item={item} onClose={() => setCreating(false)} />}
    </section>
  );
}
