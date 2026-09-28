import { useEffect, useRef, useState, type FormEvent } from "react";
import { CameraIcon, CloseIcon } from "../../components/icons";
import { Modal, deleteAttachment, uploadAttachment, type Attachment } from "../media-ai-core";
import { inspectionsApi } from "./api";
import type { DamageSuggestion, Finding, FindingArea, InspectionDetail, InspectionsMeta, Severity } from "./types";
import { BTN, BTN_QUIET, FIELD, LABEL, Notice, SEVERITY_COLOR, errorText } from "./ui";

/**
 * Add or change one finding, in the order a surveyor walks: inside or
 * outside, the room, the spot (wall, door, dock…), then the details and
 * photos.
 *
 * Given a photo and `useAi`, it uploads the photo, asks the model what it
 * shows, and opens with the answer filled in for the person to check. The
 * model can be wrong about anything, so every field stays editable, and when
 * it cannot help the form simply opens empty with the photo attached.
 */

export type FindingDefaults = { area?: FindingArea; room?: string; locationId?: string | null };

type Props = {
  inspection: InspectionDetail;
  meta: InspectionsMeta;
  finding?: Finding;
  /** A photo just taken, to upload (and read, with useAi) as the form opens. */
  photo?: File | null;
  useAi?: boolean;
  defaults?: FindingDefaults;
  onSaved: (finding: Finding) => void;
  onClose: () => void;
};

const PHOTO_STAGE = "finding";

export function FindingEditor({ inspection, meta, finding, photo, useAi = false, defaults, onSaved, onClose }: Props) {
  const [area, setArea] = useState<FindingArea>(finding?.area ?? defaults?.area ?? "inside");
  const [room, setRoom] = useState(finding?.room ?? defaults?.room ?? "");
  const [locationId, setLocationId] = useState<string | null>(finding?.locationId ?? defaults?.locationId ?? null);
  const [spot, setSpot] = useState(finding?.spot ?? "");
  const [spotDetail, setSpotDetail] = useState(finding?.spotDetail ?? "");
  const [description, setDescription] = useState(finding?.description ?? "");
  const [severity, setSeverity] = useState<Severity>(finding?.severity ?? "minor");
  const [preExisting, setPreExisting] = useState(finding?.preExisting ?? false);
  const [photos, setPhotos] = useState<Attachment[]>(finding?.photos ?? []);
  const [aiSuggestion, setAiSuggestion] = useState<DamageSuggestion | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<{ tone: "info" | "warn" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Photos uploaded while this form was open: removed again if it is cancelled.
  const added = useRef<string[]>([]);
  const started = useRef(false);

  const fillFrom = (s: DamageSuggestion) => {
    setAiSuggestion(s);
    if (s.area) setArea(s.area);
    if (s.room) {
      setRoom(s.room);
      setLocationId(s.locationId);
    }
    if (s.spot) setSpot(s.spot);
    if (s.spotDetail) setSpotDetail(s.spotDetail);
    if (s.description) setDescription(s.description);
    if (s.severity) setSeverity(s.severity);
  };

  const addPhoto = async (file: File, read: boolean) => {
    setNote(null);
    setProgress(0);
    try {
      const saved = await uploadAttachment(file, {
        ownerType: "inspection",
        ownerId: inspection.id,
        kind: "photo",
        stage: PHOTO_STAGE,
        onProgress: setProgress,
      });
      added.current.push(saved.id);
      setPhotos((p) => [...p, saved]);
      setProgress(null);
      if (!read) return;
      setReading(true);
      const result = await inspectionsApi.readDamage(inspection.id, saved.id);
      if (result.suggestion) {
        fillFrom(result.suggestion);
        setNote({
          tone: result.suggestion.damage ? "info" : "warn",
          text: result.message ?? "Filled in from the photo. Check every field before saving.",
        });
      } else {
        setNote({ tone: "warn", text: result.message ?? "The photo could not be read. Fill the finding in by hand." });
      }
    } catch (err) {
      setNote({ tone: "error", text: errorText(err, "The photo could not be saved.") });
    } finally {
      setProgress(null);
      setReading(false);
    }
  };

  useEffect(() => {
    if (!photo || started.current) return;
    started.current = true;
    void addPhoto(photo, useAi);
    // Runs once for the photo the form was opened with.
  }, [photo]);

  const pickRoom = (value: string) => {
    setRoom(value);
    const known = inspection.rooms.find((r) => r.name.toLowerCase() === value.trim().toLowerCase());
    setLocationId(known?.locationId ?? null);
  };

  const cancel = () => {
    for (const id of added.current) void deleteAttachment(id).catch(() => undefined);
    onClose();
  };

  const removePhoto = (a: Attachment) => {
    setPhotos((p) => p.filter((x) => x.id !== a.id));
    if (added.current.includes(a.id)) {
      added.current = added.current.filter((id) => id !== a.id);
      void deleteAttachment(a.id).catch(() => undefined);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    const body = {
      area,
      room: room.trim() || null,
      locationId,
      spot: spot || "other",
      spotDetail: spotDetail.trim() || null,
      description: description.trim(),
      severity,
      preExisting,
      attachmentIds: photos.map((p) => p.id),
    };
    try {
      const saved = finding
        ? await inspectionsApi.updateFinding(inspection.id, finding.id, body)
        : await inspectionsApi.addFinding(inspection.id, {
            ...body,
            aiGenerated: Boolean(aiSuggestion),
            aiSuggestion: aiSuggestion as Record<string, unknown> | null,
          });
      added.current = [];
      onSaved(saved);
    } catch (err) {
      setNote({ tone: "error", text: errorText(err, "The finding could not be saved.") });
      setBusy(false);
    }
  };

  const working = progress !== null || reading;
  const ready = !working && description.trim() && (room.trim() || locationId);

  return (
    <Modal title={finding ? `Finding #${finding.number}` : useAi ? "Add damage from a photo" : "Add damage"} onClose={cancel} wide>
      <form onSubmit={submit} className="space-y-4">
        {progress !== null && (
          <div className="space-y-1">
            <p className="text-sm text-slate-300">Uploading the photo…</p>
            <div className="h-1.5 overflow-hidden rounded bg-slate-800">
              <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </div>
        )}
        {reading && <Notice>Reading the photo: room, spot and what the damage looks like…</Notice>}
        {note && <Notice tone={note.tone}>{note.text}</Notice>}

        <fieldset>
          <legend className={LABEL}>Where</legend>
          <div className="mt-1 flex gap-2" role="radiogroup" aria-label="Inside or outside">
            {meta.areas.map((a) => (
              <button
                key={a.value}
                type="button"
                role="radio"
                aria-checked={area === a.value}
                onClick={() => setArea(a.value)}
                className={chip(area === a.value)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div>
          <label className={LABEL} htmlFor="finding-room">
            Room or place
          </label>
          <input
            id="finding-room"
            list="finding-rooms"
            value={room}
            onChange={(e) => pickRoom(e.target.value)}
            placeholder="e.g. Kitchen, Main corridor, Dock 2"
            maxLength={200}
            className={`${FIELD} mt-1`}
            required
          />
          <datalist id="finding-rooms">
            {inspection.rooms.map((r) => (
              <option key={`${r.locationId ?? ""}:${r.name}`} value={r.name} />
            ))}
          </datalist>
        </div>

        <fieldset>
          <legend className={LABEL}>Spot</legend>
          <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Spot">
            {meta.spots.map((s) => (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={spot === s.value}
                onClick={() => setSpot(s.value)}
                className={chip(spot === s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <input
            value={spotDetail}
            onChange={(e) => setSpotDetail(e.target.value)}
            placeholder="Exactly where: left of the door, 1 m up"
            aria-label="Exactly where"
            maxLength={200}
            className={`${FIELD} mt-2`}
          />
        </fieldset>

        <div>
          <label className={LABEL} htmlFor="finding-description">
            What is it
          </label>
          <textarea
            id="finding-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="e.g. Two scuff marks and a 5 cm gouge in the paint."
            className={`${FIELD} mt-1`}
            required
          />
        </div>

        <fieldset>
          <legend className={LABEL}>Severity</legend>
          <div className="mt-1 flex gap-2" role="radiogroup" aria-label="Severity">
            {meta.severities.map((s) => (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={severity === s.value}
                onClick={() => setSeverity(s.value)}
                className={chip(severity === s.value)}
                style={severity === s.value ? { borderColor: SEVERITY_COLOR[s.value], color: SEVERITY_COLOR[s.value] } : undefined}
              >
                {s.label}
              </button>
            ))}
          </div>
        </fieldset>

        {inspection.kind !== "pre" && (
          <label className="flex items-start gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={preExisting} onChange={(e) => setPreExisting(e.target.checked)} className="mt-1" />
            <span>
              Already there before the move
              <span className="block text-xs text-slate-500">
                For damage the facility contact points out that the pre-move inspection missed. It is not counted as new.
              </span>
            </span>
          </label>
        )}

        <div>
          <span className={LABEL}>Photos</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {photos.map((p) => (
              <div key={p.id} className="relative">
                <img src={p.thumbUrl ?? p.url} alt="" className="h-24 w-24 rounded-lg border border-slate-800 object-cover" />
                <button
                  type="button"
                  onClick={() => removePhoto(p)}
                  aria-label="Remove this photo"
                  className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-slate-200 hover:bg-black"
                >
                  <CloseIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <label className={`${BTN_QUIET} inline-flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-1 text-xs`}>
              <CameraIcon className="h-5 w-5" />
              Add photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                disabled={working}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void addPhoto(file, false);
                }}
              />
            </label>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy || !ready} className={`${BTN} flex-1`}>
            {busy ? "Saving…" : finding ? "Save changes" : "Save finding"}
          </button>
          <button type="button" onClick={cancel} className={BTN_QUIET}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

const chip = (on: boolean) =>
  `rounded-full border px-3 py-1.5 text-sm ${
    on ? "border-sky-500 bg-sky-950/40 text-sky-200" : "border-slate-700 text-slate-300 hover:bg-slate-800"
  }`;
