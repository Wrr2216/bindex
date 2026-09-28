import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";
import { errorMessage } from "../media-ai-core/format";
import { captureApi } from "./api";
import { BTN, BTN_PRIMARY, BboxThumb, INPUT, MINI, MODE_INFO, pct } from "./shared";
import type { CaptureDraft, CaptureSession, CommitResult, DraftPatch } from "./types";

const LOW_CONFIDENCE = 0.6;
const CATEGORIES = [
  "Seating", "Desk", "Table", "Storage", "Monitor", "Computer", "Laptop", "Peripheral", "Printer", "Phone",
  "Networking", "Audio-visual", "Appliance", "Lighting", "Artwork", "Fixture", "Equipment", "Tool", "Container", "Plant", "Other",
];

type Props = {
  session: CaptureSession;
  locations: Location[];
  onChange: (s: CaptureSession) => void;
  onError: (m: string | null) => void;
};

/**
 * The reviewable list: every entry editable, mergeable, splittable and
 * deletable, with the reason behind each automatic merge. Nothing becomes an
 * item until Create is pressed.
 */
export function DraftReview({ session, locations, onChange, onError }: Props) {
  const terms = useTerms();
  const open = session.status === "open";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  const act = async (fn: () => Promise<CaptureSession>) => {
    setBusy(true);
    onError(null);
    try {
      onChange(await fn());
      return true;
    } catch (err) {
      onError(errorMessage(err, "That did not work."));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const visible = session.drafts.filter((d) => showDeleted || d.status !== "discarded");
  const pickable = new Set(session.drafts.filter((d) => d.status === "pending").map((d) => d.id));
  const picked = [...selected].filter((id) => pickable.has(id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const merge = async () => {
    // The first entry in the list keeps its name and place.
    const ids = session.drafts.filter((d) => picked.includes(d.id)).map((d) => d.id);
    if (await act(() => captureApi.mergeDrafts(session.id, ids))) setSelected(new Set());
  };

  if (!session.drafts.length && !open) return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Draft list{" "}
          <span className="normal-case tracking-normal text-slate-500">
            {session.counts.pending} to create
            {session.counts.created ? ` · ${session.counts.created} created` : ""}
            {session.counts.discarded ? ` · ${session.counts.discarded} deleted` : ""}
          </span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {session.counts.discarded > 0 && (
            <button type="button" className={BTN} onClick={() => setShowDeleted((v) => !v)} aria-pressed={showDeleted}>
              {showDeleted ? "Hide deleted" : "Show deleted"}
            </button>
          )}
          {open && picked.length >= 2 && (
            <button type="button" className={BTN} disabled={busy} onClick={() => void merge()}>
              Merge {picked.length} selected
            </button>
          )}
          {open && (
            <button type="button" className={BTN} onClick={() => setEditing("new")}>
              Add entry
            </button>
          )}
        </div>
      </div>

      {open && session.drafts.length > 0 && (
        <p className="text-xs text-slate-500">
          Check each entry against what is really there. Amber entries were hard to read. Tick two or more to merge
          them; split one that covers different things.
        </p>
      )}

      {editing === "new" && (
        <DraftEditor
          session={session}
          locations={locations}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (patch) => {
            if (await act(() => captureApi.addDraft(session.id, { ...patch, name: patch.name ?? "" }))) setEditing(null);
          }}
        />
      )}

      {visible.length === 0 ? (
        open && <p className="text-sm text-slate-500">The list fills in as images are analysed.</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((d) =>
            editing === d.id ? (
              <li key={d.id}>
                <DraftEditor
                  session={session}
                  locations={locations}
                  draft={d}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={async (patch) => {
                    if (await act(() => captureApi.updateDraft(session.id, d.id, patch))) setEditing(null);
                  }}
                />
              </li>
            ) : (
              <DraftCard
                key={d.id}
                draft={d}
                session={session}
                locations={locations}
                selected={selected.has(d.id)}
                busy={busy}
                onToggle={() => toggle(d.id)}
                onEdit={() => setEditing(d.id)}
                onAct={act}
              />
            ),
          )}
        </ul>
      )}

      {result && (
        <p className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-300">
          Created {result.itemCount} {(result.itemCount === 1 ? terms.item.singular : terms.item.plural).toLowerCase()}.
          {result.photos.saved > 0 && " Those read from an image keep a copy of it, under their photos."}
          {result.photos.failed > 0 && ` ${result.photos.failed} could not be given their image; see the server log.`}
        </p>
      )}
      {open && session.counts.pending > 0 && (
        <CommitPanel
          session={session}
          busy={busy}
          setBusy={setBusy}
          onCommitted={(r) => {
            setResult(r);
            onChange(r.session);
          }}
          onError={onError}
        />
      )}
    </section>
  );
}

function DraftCard({
  draft: d,
  session,
  locations,
  selected,
  busy,
  onToggle,
  onEdit,
  onAct,
}: {
  draft: CaptureDraft;
  session: CaptureSession;
  locations: Location[];
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onAct: (fn: () => Promise<CaptureSession>) => Promise<boolean>;
}) {
  const terms = useTerms();
  const open = session.status === "open";
  const pending = d.status === "pending";
  const unsure = pending && !d.edited && d.confidence !== null && d.confidence < LOW_CONFIDENCE;
  const shown = d.sources.find((s) => s.bbox && !s.missing) ?? d.sources.find((s) => !s.missing) ?? null;
  const distinctSources = new Set(d.sources.map((s) => s.sourceId)).size;
  const location = d.locationId ? locations.find((l) => l.id === d.locationId) : null;
  const areaWord = MODE_INFO[session.mode].area ?? "Room";
  const sticker = [d.stickerColor, d.stickerLot, d.stickerNumber ? `#${d.stickerNumber}` : null].filter(Boolean).join(" ");

  const splitOff = () => {
    const n = Number(window.prompt(`How many of the ${d.qty} are something else?`, "1"));
    if (Number.isInteger(n) && n >= 1 && n < d.qty) void onAct(() => captureApi.splitDraft(session.id, d.id, { qty: n }));
  };

  return (
    <li
      className={`flex gap-3 rounded-xl border p-3 ${
        d.status === "discarded"
          ? "border-slate-800 bg-slate-900/40 opacity-60"
          : unsure
            ? "border-amber-800/70 bg-slate-900"
            : selected
              ? "border-sky-700 bg-slate-900"
              : "border-slate-800 bg-slate-900"
      }`}
    >
      {open && pending && (
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${d.name}`} className="mt-1" />
      )}
      {shown ? (
        <a href={`/api/attachments/${shown.attachmentId}`} target="_blank" rel="noreferrer" title={`From ${shown.label}`}>
          <BboxThumb src={`/api/attachments/${shown.attachmentId}/thumb?w=640`} bbox={shown.bbox} alt={d.name} />
        </a>
      ) : (
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-slate-700 text-[10px] text-slate-500">
          {d.manual ? "Added" : "No image"}
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-slate-100">{d.name}</span>
          <span className="text-sm tabular-nums text-slate-300">× {d.qty}</span>
          {d.status === "discarded" && <span className="text-xs text-slate-500">Deleted</span>}
          {d.status === "created" && <span className="text-xs text-emerald-400">Created</span>}
          {unsure && <span className="text-xs text-amber-300">Check this ({pct(d.confidence)} sure)</span>}
        </div>
        <p className="text-xs text-slate-400">
          {[
            d.category,
            [d.brand, d.model].filter(Boolean).join(" "),
            d.area ? `${areaWord}: ${d.area}` : null,
            location ? `${terms.location.singular}: ${location.name}` : null,
            d.lineNo ? `Line ${d.lineNo}` : null,
            sticker ? `Sticker ${sticker}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {(d.condition || d.description) && (
          <p className="text-xs text-slate-400">
            {d.condition && <span className="text-slate-300">Condition: {d.condition}. </span>}
            {d.description}
          </p>
        )}
        {d.explanation && <p className="text-xs italic text-slate-500">{d.explanation}</p>}
        {d.status === "created" && d.createdItemIds.length > 0 && (
          <p className="flex flex-wrap gap-2 text-xs">
            {d.createdItemIds.slice(0, 10).map((id, i) => (
              <Link key={id} to={`/items/${id}`} className="text-sky-400 hover:underline">
                {d.createdItemIds.length > 1 ? `Open ${i + 1}` : `Open ${terms.item.singular.toLowerCase()}`}
              </Link>
            ))}
            {d.createdItemIds.length > 10 && <span className="text-slate-500">and {d.createdItemIds.length - 10} more</span>}
          </p>
        )}
        {open && d.status !== "created" && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {pending && (
              <button type="button" className={MINI} disabled={busy} onClick={onEdit}>
                Edit
              </button>
            )}
            {pending && distinctSources >= 2 && (
              <button
                type="button"
                className={MINI}
                disabled={busy}
                onClick={() => void onAct(() => captureApi.splitDraft(session.id, d.id, { by: "source" }))}
              >
                Split by image
              </button>
            )}
            {pending && d.qty > 1 && (
              <button type="button" className={MINI} disabled={busy} onClick={splitOff}>
                Split off…
              </button>
            )}
            {pending ? (
              <button
                type="button"
                className={`${MINI} text-red-300`}
                disabled={busy}
                onClick={() => void onAct(() => captureApi.discardDraft(session.id, d.id))}
              >
                Delete
              </button>
            ) : (
              <button
                type="button"
                className={MINI}
                disabled={busy}
                onClick={() => void onAct(() => captureApi.updateDraft(session.id, d.id, { status: "pending" }))}
              >
                Restore
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function DraftEditor({
  session,
  locations,
  draft,
  busy,
  onSave,
  onCancel,
}: {
  session: CaptureSession;
  locations: Location[];
  draft?: CaptureDraft;
  busy: boolean;
  onSave: (patch: DraftPatch) => Promise<void>;
  onCancel: () => void;
}) {
  const terms = useTerms();
  const manifest = session.mode === "manifest";
  const areaWord = MODE_INFO[session.mode].area ?? "Room";
  const [f, setF] = useState({
    name: draft?.name ?? "",
    qty: String(draft?.qty ?? 1),
    category: draft?.category ?? "",
    brand: draft?.brand ?? "",
    model: draft?.model ?? "",
    description: draft?.description ?? "",
    area: draft?.area ?? "",
    locationId: draft?.locationId ?? "",
    lineNo: draft?.lineNo ? String(draft.lineNo) : "",
    condition: draft?.condition ?? "",
    stickerColor: draft?.stickerColor ?? "",
    stickerLot: draft?.stickerLot ?? "",
    stickerNumber: draft?.stickerNumber ?? "",
  });
  const [err, setErr] = useState<string | null>(null);
  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const sorted = useMemo(() => [...locations].sort((a, b) => label(a).localeCompare(label(b))), [locations, label]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = () => {
    const qty = Number(f.qty);
    if (!f.name.trim()) return setErr("Give it a name.");
    if (!Number.isInteger(qty) || qty < 1) return setErr("The quantity is a whole number, 1 or more.");
    const lineNo = f.lineNo.trim() ? Number(f.lineNo) : null;
    if (lineNo !== null && (!Number.isInteger(lineNo) || lineNo < 1)) return setErr("The line number is a whole number.");
    const text = (v: string) => v.trim() || null;
    const patch: DraftPatch = {
      name: f.name.trim(),
      category: text(f.category),
      brand: text(f.brand),
      model: text(f.model),
      description: text(f.description),
      area: text(f.area),
      locationId: f.locationId || null,
      ...(manifest
        ? {
            lineNo,
            condition: text(f.condition),
            stickerColor: text(f.stickerColor),
            stickerLot: text(f.stickerLot),
            stickerNumber: text(f.stickerNumber),
          }
        : {}),
    };
    // Only send the quantity when it changed, so an untouched count stays automatic.
    if (!draft || qty !== draft.qty) patch.qty = qty;
    setErr(null);
    void onSave(patch);
  };

  const field = (k: keyof typeof f, name: string, props: { type?: string; list?: string; wide?: boolean } = {}) => (
    <label className={`block ${props.wide ? "sm:col-span-2" : ""}`}>
      <span className="text-xs uppercase tracking-wide text-slate-400">{name}</span>
      <input value={f[k]} onChange={set(k)} type={props.type} list={props.list} className={`${INPUT} mt-1`} />
    </label>
  );

  return (
    <form
      className="space-y-3 rounded-xl border border-sky-800 bg-slate-900 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-4">
        {field("name", "Name", { wide: true })}
        {field("qty", "Quantity", { type: "number" })}
        {field("category", "Category", { list: "bulk-capture-categories" })}
        {field("brand", "Brand")}
        {field("model", "Model")}
        {field("area", areaWord)}
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-slate-400">{terms.location.singular}</span>
          <select value={f.locationId} onChange={set("locationId")} className={`${INPUT} mt-1`}>
            <option value="">Automatic</option>
            {sorted.map((l) => (
              <option key={l.id} value={l.id}>
                {label(l)}
              </option>
            ))}
          </select>
        </label>
        {manifest && field("lineNo", "Line", { type: "number" })}
        {manifest && field("stickerColor", "Sticker colour")}
        {manifest && field("stickerLot", "Lot")}
        {manifest && field("stickerNumber", "Sticker number")}
        {manifest && field("condition", "Condition", { wide: true })}
        <label className="block sm:col-span-4">
          <span className="text-xs uppercase tracking-wide text-slate-400">Description</span>
          <textarea value={f.description} onChange={set("description")} rows={2} className={`${INPUT} mt-1`} />
        </label>
      </div>
      <datalist id="bulk-capture-categories">
        {CATEGORIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {err && <p className="text-sm text-red-400">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={busy}>
          {draft ? "Save" : "Add"}
        </button>
        <button type="button" className={BTN} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CommitPanel({
  session,
  busy,
  setBusy,
  onCommitted,
  onError,
}: {
  session: CaptureSession;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onCommitted: (r: CommitResult) => void;
  onError: (m: string | null) => void;
}) {
  const terms = useTerms();
  const pending = session.drafts.filter((d) => d.status === "pending");
  const hasAreas = pending.some((d) => d.area);
  const [individual, setIndividual] = useState(session.mode === "desk");
  const [areaLocations, setAreaLocations] = useState(session.mode === "desk");
  const pieces = pending.reduce((n, d) => n + d.qty, 0);
  const records = individual ? pieces : pending.length;
  const itemWord = (n: number) => (n === 1 ? terms.item.singular : terms.item.plural).toLowerCase();
  const areaWord = (MODE_INFO[session.mode].area ?? "room").toLowerCase();
  const analysing = session.toAnalyse > 0;

  const commit = async () => {
    const where = session.locationName ? ` in ${session.locationName}` : "";
    if (!window.confirm(`Create ${records} ${itemWord(records)}${where} from ${pending.length} reviewed entries?`)) return;
    setBusy(true);
    onError(null);
    try {
      onCommitted(await captureApi.commit(session.id, { individual, areaLocations: hasAreas && areaLocations }));
    } catch (err) {
      onError(errorMessage(err, "Nothing was created."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-emerald-900/60 bg-emerald-950/10 p-4">
      <p className="text-sm text-slate-200">
        {pending.length} entr{pending.length === 1 ? "y" : "ies"}, {pieces} piece{pieces === 1 ? "" : "s"} in all.
        {session.locationName
          ? ` They go into ${session.locationName} unless an entry says otherwise.`
          : ` No ${terms.location.singular.toLowerCase()} is set, so they will not be placed anywhere unless an entry says so.`}
      </p>
      <label className="flex items-start gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={individual} onChange={(e) => setIndividual(e.target.checked)} className="mt-1" />
        <span>
          One record per piece
          <span className="block text-xs text-slate-500">
            Each monitor or chair gets its own record and label, rather than one record with a quantity.
          </span>
        </span>
      </label>
      {hasAreas && (
        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={areaLocations} onChange={(e) => setAreaLocations(e.target.checked)} className="mt-1" />
          <span>
            A {terms.location.singular.toLowerCase()} for each {areaWord}
            <span className="block text-xs text-slate-500">
              Entries go into the {terms.location.singular.toLowerCase()} named after their {areaWord}
              {session.locationName ? `, inside ${session.locationName}` : ""}, created when it does not exist. Unticked,
              an existing one of that name is still used.
            </span>
          </span>
        </label>
      )}
      {analysing && <p className="text-xs text-amber-300">Some images are still waiting to be analysed; their entries are not in the list yet.</p>}
      <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void commit()}>
        Create {records} {itemWord(records)}
      </button>
    </section>
  );
}
