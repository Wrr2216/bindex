import { useEffect, useRef, useState } from "react";
import { AlertIcon } from "../../components/icons";
import { conditionApi } from "./api";
import { DefectEditor } from "./DefectEditor";
import { PhotoPicker, type PickedPhoto } from "./PhotoPicker";
import type { ConditionRating, ConditionReport, ConditionStage, Defect } from "./types";
import { RATINGS, RATING_LABEL, RATING_TONE, STAGES, STAGE_LABEL, errorMessage, photoStage, useConditionAi } from "./vocab";

const INPUT =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
const LABEL = "mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400";
const AI_RING = "ring-1 ring-sky-600";

export type ReportFormItem = {
  id: string;
  name: string;
  units?: { id: string; label: string }[];
};

type AiField = "rating" | "aiNotes" | "defects" | "handlingNote";

const sameDefect = (a: Defect, b: Defect) => a.type === b.type && a.area.trim().toLowerCase() === b.area.trim().toLowerCase();

/**
 * Record or correct one condition report. "Assess with AI" fills a draft from
 * the chosen photos; the fields it filled are outlined until someone touches
 * them, and nothing is saved until Save.
 */
export function ReportForm({
  item,
  report,
  defaults,
  lockStage,
  sweepId,
  saveLabel = "Save report",
  autoAssess = false,
  onSaved,
  onCancel,
}: {
  item: ReportFormItem;
  /** Editing an existing report. */
  report?: ConditionReport;
  /** For a new report: the stage to start on, the unit, and the handling note to carry forward. */
  defaults?: { stage?: ConditionStage; unitId?: string | null; handlingNote?: string | null };
  /** A sweep fixes the stage. */
  lockStage?: ConditionStage;
  sweepId?: string;
  saveLabel?: string;
  /** Run the AI assessment as soon as the first photo is in, as a sweep does. */
  autoAssess?: boolean;
  onSaved: (report: ConditionReport) => void;
  onCancel?: () => void;
}) {
  const aiOn = useConditionAi();
  const [stage, setStage] = useState<ConditionStage>(lockStage ?? report?.stage ?? defaults?.stage ?? "inspection");
  const [stageLabel, setStageLabel] = useState(report?.stageLabel ?? "");
  const [unitId, setUnitId] = useState<string | null>(report?.unitId ?? defaults?.unitId ?? null);
  const [rating, setRating] = useState<ConditionRating | null>(report?.rating ?? null);
  const [notes, setNotes] = useState(report?.notes ?? "");
  const [aiNotes, setAiNotes] = useState(report?.aiNotes ?? "");
  const [defects, setDefects] = useState<Defect[]>(report?.defects ?? []);
  const [handlingNote, setHandlingNote] = useState(report?.handlingNote ?? defaults?.handlingNote ?? "");
  const [photos, setPhotos] = useState<PickedPhoto[]>(report?.photos.map((p) => ({ id: p.id, url: p.url, thumbUrl: p.thumbUrl })) ?? []);
  const [selected, setSelected] = useState<string[]>(report?.photos.map((p) => p.id) ?? []);
  const [aiAssisted, setAiAssisted] = useState(report?.aiAssisted ?? false);
  const [aiFilled, setAiFilled] = useState<Set<AiField>>(new Set());
  const [aiNote, setAiNote] = useState<{ tone: "info" | "warn"; text: string } | null>(null);
  const [suggestedHandling, setSuggestedHandling] = useState<string | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const touched = (f: AiField) =>
    setAiFilled((s) => {
      if (!s.has(f)) return s;
      const n = new Set(s);
      n.delete(f);
      return n;
    });

  const assess = async () => {
    setAssessing(true);
    setAiNote(null);
    setError(null);
    try {
      const res = await conditionApi.assess(item.id, selected);
      if (!res.available) {
        setAiNote({ tone: "warn", text: "No vision model is configured. Fill the report in by hand." });
        return;
      }
      if (!res.draft) {
        setAiNote({ tone: "warn", text: res.message ?? "Nothing could be read from these photos." });
        return;
      }
      const d = res.draft;
      const filled = new Set<AiField>();
      if (d.rating) {
        setRating(d.rating);
        filled.add("rating");
      }
      if (d.summary) {
        setAiNotes(d.summary);
        filled.add("aiNotes");
      }
      if (d.defects.length) {
        // Keep what the person already listed; add what the model saw on top.
        setDefects((cur) => [...cur, ...d.defects.filter((x) => !cur.some((c) => sameDefect(c, x)))]);
        filled.add("defects");
      }
      if (d.handlingNote) {
        if (!handlingNote.trim()) {
          setHandlingNote(d.handlingNote);
          filled.add("handlingNote");
        } else if (d.handlingNote.trim() !== handlingNote.trim()) {
          setSuggestedHandling(d.handlingNote);
        }
      }
      setAiFilled(filled);
      setAiAssisted(true);
      const unsure = d.confidence !== null && d.confidence < res.lowConfidence;
      setAiNote(
        unsure
          ? { tone: "warn", text: "The model was unsure about these photos. Check every outlined field before saving." }
          : { tone: "info", text: "Filled from the photos. Check the outlined fields before saving." },
      );
    } catch (err) {
      setAiNote({ tone: "warn", text: errorMessage(err, "The photos could not be assessed.") });
    } finally {
      setAssessing(false);
    }
  };

  // Once per form: after that, the person decides when to ask again.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoAssess || !aiOn || autoRan.current || !selected.length || assessing) return;
    autoRan.current = true;
    void assess();
    // Keyed on the photo count only: assess reads the latest state when it runs.
  }, [autoAssess, aiOn, selected.length]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const payload = {
      unitId,
      stage,
      stageLabel: stage === "custom" ? stageLabel.trim() || null : null,
      rating,
      notes: notes.trim() || null,
      aiNotes: aiNotes.trim() || null,
      // A row left blank is not a defect.
      defects: defects.filter((d) => d.area.trim() || d.description?.trim()),
      handlingNote: handlingNote.trim() || null,
      attachmentIds: selected,
      aiAssisted,
    };
    try {
      const saved = report
        ? await conditionApi.updateReport(report.id, payload)
        : await conditionApi.createReport({ ...payload, itemId: item.id, sweepId: sweepId ?? null });
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err, "The report could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const units = item.units ?? [];
  const ownerType = unitId ? "unit" : "item";
  const ownerId = unitId ?? item.id;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={LABEL}>Stage</span>
          {lockStage ? (
            <p className="py-2 text-sm text-slate-200">{STAGE_LABEL[lockStage]}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Stage">
              {STAGES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStage(s)}
                  aria-pressed={stage === s}
                  className={`rounded-lg px-3 py-1.5 text-sm ${stage === s ? "bg-slate-200 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
                >
                  {STAGE_LABEL[s]}
                </button>
              ))}
            </div>
          )}
          {stage === "custom" && !lockStage && (
            <input
              value={stageLabel}
              onChange={(e) => setStageLabel(e.target.value)}
              placeholder="Name the stage (return, pre-sale)"
              aria-label="Stage name"
              maxLength={40}
              className={`${INPUT} mt-2`}
            />
          )}
        </div>
        {units.length > 0 && (
          <label className="block">
            <span className={LABEL}>Which one</span>
            <select value={unitId ?? ""} onChange={(e) => setUnitId(e.target.value || null)} className={INPUT} disabled={Boolean(report)}>
              <option value="">The whole {item.name}</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div>
        <span className={LABEL}>Photos</span>
        <PhotoPicker
          ownerType={ownerType}
          ownerId={ownerId}
          stage={photoStage(stage, stageLabel)}
          photos={photos}
          onPhotos={setPhotos}
          selected={selected}
          onSelected={setSelected}
          max={6}
          hint="Show each side, and a close-up of any damage."
        />
        {aiOn && (
          <button
            type="button"
            onClick={() => void assess()}
            disabled={assessing || !selected.length}
            title={selected.length ? undefined : "Take or pick a photo first"}
            className="mt-2 rounded-lg bg-violet-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
          >
            {assessing ? "Assessing…" : "Assess with AI"}
          </button>
        )}
        {aiNote && (
          <p
            className={`mt-2 flex items-start gap-1.5 rounded-lg px-3 py-2 text-sm ${
              aiNote.tone === "warn" ? "bg-amber-950/60 text-amber-200" : "bg-sky-950/60 text-sky-200"
            }`}
          >
            {aiNote.tone === "warn" && <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />}
            {aiNote.text}
          </p>
        )}
      </div>

      <div>
        <span className={LABEL}>Condition</span>
        <div className={`flex flex-wrap gap-1.5 rounded-lg p-0.5 ${aiFilled.has("rating") ? AI_RING : ""}`} role="group" aria-label="Condition">
          {RATINGS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                setRating(rating === r ? null : r);
                touched("rating");
              }}
              aria-pressed={rating === r}
              className={`rounded-lg border px-3 py-1.5 text-sm ${rating === r ? RATING_TONE[r] : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
            >
              {RATING_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      {(aiNotes || aiFilled.has("aiNotes")) && (
        <label className="block">
          <span className={LABEL}>What the AI saw</span>
          <textarea
            value={aiNotes}
            onChange={(e) => {
              setAiNotes(e.target.value);
              touched("aiNotes");
            }}
            rows={2}
            maxLength={4000}
            className={`${INPUT} ${aiFilled.has("aiNotes") ? AI_RING : ""}`}
          />
        </label>
      )}

      <label className="block">
        <span className={LABEL}>Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={4000} placeholder="Anything else worth recording" className={INPUT} />
      </label>

      <div>
        <span className={LABEL}>Defects</span>
        <DefectEditor
          defects={defects}
          highlight={aiFilled.has("defects")}
          onChange={(d) => {
            setDefects(d);
            touched("defects");
          }}
        />
      </div>

      <label className="block">
        <span className={LABEL}>Handling note</span>
        <input
          value={handlingNote}
          onChange={(e) => {
            setHandlingNote(e.target.value);
            touched("handlingNote");
          }}
          maxLength={300}
          placeholder="Shown to crews wherever this is scanned (handle with care…)"
          className={`${INPUT} ${aiFilled.has("handlingNote") ? AI_RING : ""}`}
        />
        {suggestedHandling && (
          <span className="mt-1 block text-xs text-slate-400">
            AI suggests: “{suggestedHandling}”{" "}
            <button
              type="button"
              onClick={() => {
                setHandlingNote(suggestedHandling);
                setSuggestedHandling(null);
              }}
              className="text-sky-400 hover:underline"
            >
              Use it
            </button>
          </span>
        )}
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || (stage === "custom" && !stageLabel.trim())}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : saveLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
