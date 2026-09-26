import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";
import { errorMessage } from "../media-ai-core/format";
import { captureApi } from "./api";
import { BTN, BTN_PRIMARY, INPUT, MODE_INFO, useBulkCaptureEnabled } from "./shared";
import type { BulkCaptureStatus, CaptureMode, CaptureSessionSummary } from "./types";

const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";

/** Bulk capture: start a walkthrough, a desk survey or a paper conversion, or pick up one in progress. */
export function CaptureListPage() {
  const enabled = useBulkCaptureEnabled();
  const [sessions, setSessions] = useState<CaptureSessionSummary[] | null>(null);
  const [status, setStatus] = useState<BulkCaptureStatus | null>(null);
  const [starting, setStarting] = useState<CaptureMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    captureApi
      .list()
      .then(setSessions)
      .catch((err) => {
        setSessions([]);
        setError(errorMessage(err, "Could not load capture sessions."));
      });
    captureApi.status().then(setStatus).catch(() => undefined);
  }, []);

  const open = (sessions ?? []).filter((s) => s.status === "open");
  const done = (sessions ?? []).filter((s) => s.status === "committed");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Bulk capture</h1>
        <p className="mt-1 text-sm text-slate-400">
          Photograph a room, record a walk through a floor, survey desks, or convert a paper inventory. The AI drafts a
          list for you to check and correct; nothing is created until you confirm it.
        </p>
      </div>

      {!enabled && (
        <p className="rounded-xl border border-amber-900/60 bg-amber-950/30 p-4 text-sm text-amber-200">
          Bulk capture needs a vision model. An administrator can configure one with LLM_API_KEY and LLM_VISION_MODEL;
          see the attachments and AI capture documentation.
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        {(Object.keys(MODE_INFO) as CaptureMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={!enabled}
            onClick={() => setStarting(mode)}
            aria-pressed={starting === mode}
            className={`rounded-xl border p-4 text-left transition disabled:opacity-50 ${
              starting === mode ? "border-sky-600 bg-sky-950/30" : "border-slate-800 bg-slate-900 hover:border-slate-600"
            }`}
          >
            <span className="font-semibold text-slate-100">{MODE_INFO[mode].title}</span>
            <span className="mt-1 block text-sm text-slate-400">{MODE_INFO[mode].blurb}</span>
          </button>
        ))}
      </section>

      {starting && status && <StartForm key={starting} mode={starting} status={status} onCancel={() => setStarting(null)} />}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {sessions === null ? (
        <p className="py-6 text-center text-slate-500">Loading…</p>
      ) : (
        <>
          <SessionList title="In progress" sessions={open} empty="Nothing in progress." />
          {done.length > 0 && <SessionList title="Finished" sessions={done} />}
        </>
      )}
    </div>
  );
}

function StartForm({ mode, status, onCancel }: { mode: CaptureMode; status: BulkCaptureStatus; onCancel: () => void }) {
  const terms = useTerms();
  const navigate = useNavigate();
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [title, setTitle] = useState("");
  const [overlap, setOverlap] = useState(true);
  const [template, setTemplate] = useState(status.deskTemplates[0]?.id ?? "");
  const [cap, setCap] = useState(String(status.maxImagesPerSession));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);
  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const sorted = useMemo(() => [...locations].sort((a, b) => label(a).localeCompare(label(b))), [locations, label]);

  const start = async () => {
    const imageCap = Number(cap);
    if (!Number.isInteger(imageCap) || imageCap < 1 || imageCap > status.maxImagesPerSession) {
      setError(`Set a cap between 1 and ${status.maxImagesPerSession} images.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await captureApi.create({
        mode,
        title: title.trim() || null,
        locationId: locationId || null,
        imageCap,
        countRule: overlap ? "max" : "sum",
        deskTemplateId: mode === "desk" ? template : null,
      });
      navigate(`/capture/${s.id}`);
    } catch (err) {
      setError(errorMessage(err, "Could not start the session."));
      setBusy(false);
    }
  };

  const where =
    mode === "desk"
      ? `The office or floor. Each desk becomes its own ${terms.location.singular.toLowerCase()} inside it if you choose.`
      : mode === "manifest"
        ? `Where the listed things are. Rooms written on the pages become ${terms.location.plural.toLowerCase()} inside it if you choose.`
        : `The room or floor being photographed. Created ${terms.item.plural.toLowerCase()} go here.`;

  return (
    <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="font-semibold text-slate-100">New {MODE_INFO[mode].title.toLowerCase()}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>{terms.location.singular}</span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={`${INPUT} mt-1`}>
            <option value="">None yet</option>
            {sorted.map((l) => (
              <option key={l.id} value={l.id}>
                {label(l)}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-slate-500">{where}</span>
        </label>
        <label className="block">
          <span className={LABEL}>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Named after the place and date if left blank"
            className={`${INPUT} mt-1`}
            maxLength={200}
          />
        </label>
        {mode === "desk" && status.deskTemplates.length > 0 && (
          <label className="block">
            <span className={LABEL}>Standard kit per desk</span>
            <select value={template} onChange={(e) => setTemplate(e.target.value)} className={`${INPUT} mt-1`}>
              {status.deskTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}: {t.items.map((i) => `${i.qty} × ${i.label.toLowerCase()}`).join(", ")}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className={LABEL}>Image cap</span>
          <input
            type="number"
            min={1}
            max={status.maxImagesPerSession}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            className={`${INPUT} mt-1`}
          />
          <span className="mt-1 block text-xs text-slate-500">
            The most images this session may send to the vision model, each a paid request. Up to{" "}
            {status.maxImagesPerSession}.
          </span>
        </label>
        {mode !== "manifest" && (
          <label className="flex items-start gap-2 sm:col-span-2">
            <input type="checkbox" checked={overlap} onChange={(e) => setOverlap(e.target.checked)} className="mt-1" />
            <span className="text-sm text-slate-300">
              My photos overlap
              <span className="block text-xs text-slate-500">
                When the same things appear in several photos, count them once, at the largest number seen. Untick when
                each photo shows a different part of the room, so counts add up.
              </span>
            </span>
          </label>
        )}
      </div>
      {!status.video && mode === "walkthrough" && (
        <p className="text-xs text-slate-500">Video is unavailable on this server (ffmpeg is not installed); use photos.</p>
      )}
      {!status.pdf && mode === "manifest" && (
        <p className="text-xs text-slate-500">
          PDFs cannot be read on this server (pdftoppm is not installed); photograph the pages or upload images.
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void start()} disabled={busy} className={BTN_PRIMARY}>
          {busy ? "Starting…" : "Start"}
        </button>
        <button type="button" onClick={onCancel} className={BTN}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function SessionList({ title, sessions, empty }: { title: string; sessions: CaptureSessionSummary[]; empty?: string }) {
  const terms = useTerms();
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
      {sessions.length === 0 ? (
        <p className="text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
          {sessions.map((s) => (
            <li key={s.id}>
              <Link to={`/capture/${s.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-slate-800/60">
                <span>
                  <span className="block font-medium text-slate-100">{s.title}</span>
                  <span className="text-xs text-slate-400">
                    {s.modeLabel}
                    {s.locationName ? ` · ${s.locationName}` : ""} · {new Date(s.updatedAt).toLocaleString()}
                  </span>
                </span>
                <span className="text-xs text-slate-400">
                  {s.status === "committed"
                    ? `${s.draftsCreated} ${s.draftsCreated === 1 ? "entry" : "entries"} created as ${terms.item.plural.toLowerCase()}`
                    : [
                        `${s.sources} image${s.sources === 1 ? "" : "s"}`,
                        s.toAnalyse ? `${s.toAnalyse} to analyse` : null,
                        `${s.draftsPending} to review`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
