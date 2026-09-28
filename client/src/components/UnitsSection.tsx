import { useEffect, useState, type FormEvent } from "react";
import { api, type UnitPayload } from "../api/client";
import { useMoney, useTerms } from "../config/useConfig";
import type { Entity, ItemDetail, ItemUnit, Location } from "../types";
import { CloseIcon } from "./icons";
import { UnitTagActions } from "../features/tag-commissioning/UnitTagActions";

const STATUSES = ["active", "in_repair", "retired", "lost"];
const SEL =
  "rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100";
const MINI_BTN =
  "rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800";

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** A typed amount as whole cents, or null when it is empty or not a number. */
function parseCents(input: string): number | null {
  const n = parseFloat(input.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

const openPrint = (query: string) => window.open(`/print?${query}`, "_blank", "noopener");

/**
 * Individually tracked copies of one item. Each unit carries its own printed
 * code, in the same shape as an item's so one reader resolves both, plus its
 * own label, serial, status, location and holder. The item's quantity follows
 * the number of units.
 */
export function UnitsSection({
  item,
  onChange,
  highlightUnitId,
}: {
  item: ItemDetail;
  onChange: (i: ItemDetail) => void;
  highlightUnitId?: string | null;
}) {
  const money = useMoney();
  const terms = useTerms();
  const [locations, setLocations] = useState<Location[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [label, setLabel] = useState("");
  // Entity picked for check-out, per unit (each card has its own select).
  const [checkoutEntity, setCheckoutEntity] = useState<Record<string, string>>({});
  const [serial, setSerial] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
    api.listEntities().then(setEntities).catch(() => undefined);
  }, []);

  const run = async (fn: () => Promise<ItemDetail>) => {
    setBusy(true);
    setErr(null);
    try {
      onChange(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(() =>
      api.addUnit(item.id, { label: label.trim() || null, serial: serial.trim() || null }),
    ).then(() => {
      setLabel("");
      setSerial("");
    });
  };
  const patch = (u: ItemUnit, p: UnitPayload) => run(() => api.updateUnit(item.id, u.id, p));
  const del = (u: ItemUnit) => {
    if (!confirm(`Remove unit ${u.label ?? u.serial ?? u.assetCode}?`)) return;
    void run(() => api.deleteUnit(item.id, u.id));
  };

  const printAll = () => openPrint(`units=${item.units.map((u) => u.id).join(",")}`);

  const checkOut = (u: ItemUnit) => {
    const entityId = checkoutEntity[u.id];
    if (!entityId) return;
    void run(() => api.checkOutUnit(item.id, u.id, entityId)).then(() =>
      setCheckoutEntity((prev) => ({ ...prev, [u.id]: "" })),
    );
  };
  const checkIn = (u: ItemUnit) => void run(() => api.checkInUnit(item.id, u.id));

  return (
    <section>
      <h2 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Units ({item.units.length})
        {item.units.length > 0 && (
          <>
            <span className="text-emerald-400">
              · {money(item.units.reduce((sum, u) => sum + (u.valueCents ?? 0), 0))} total
            </span>
            <button onClick={printAll} className={`${MINI_BTN} normal-case tracking-normal`}>
              Print all unit labels
            </button>
          </>
        )}
      </h2>

      <div className="space-y-2">
        {item.units.map((u) => (
          <div
            key={u.id}
            className={`rounded-lg border p-3 ${
              highlightUnitId === u.id
                ? "border-sky-500 bg-sky-950/30"
                : "border-slate-800 bg-slate-900"
            }`}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs text-slate-400" title="This unit's printed code">
                {u.assetCode}
              </span>
              <div className="flex flex-wrap gap-1">
                <button onClick={() => openPrint(`unit=${u.id}`)} className={MINI_BTN}>
                  Print label
                </button>
                <button
                  onClick={() => openPrint(`unit=${u.id}&style=compact`)}
                  title="Just the QR code with the code beneath it"
                  className={MINI_BTN}
                >
                  Compact
                </button>
                <a
                  href={api.unitLabelPreviewUrl(u.id)}
                  target="_blank"
                  rel="noreferrer"
                  className={MINI_BTN}
                >
                  Preview
                </a>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                defaultValue={u.label ?? ""}
                placeholder="label (e.g. Unit 1)"
                aria-label="Unit label"
                onBlur={(e) =>
                  e.target.value !== (u.label ?? "") && patch(u, { label: e.target.value })
                }
                className={`${SEL} flex-1`}
              />
              <input
                defaultValue={u.serial ?? ""}
                placeholder="serial"
                aria-label="Unit serial"
                onBlur={(e) => e.target.value !== (u.serial ?? "") && patch(u, { serial: e.target.value })}
                className={`${SEL} flex-1 font-mono`}
              />
              <select value={u.status} onChange={(e) => patch(u, { status: e.target.value })} className={SEL}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                defaultValue={u.valueCents != null ? (u.valueCents / 100).toFixed(2) : ""}
                placeholder="value"
                aria-label="Unit value"
                onBlur={(e) => {
                  const cents = parseCents(e.target.value);
                  if (cents !== (u.valueCents ?? null)) patch(u, { valueCents: cents });
                }}
                className={`${SEL} w-24`}
              />
              <button
                onClick={() => del(u)}
                aria-label="Remove unit"
                className="rounded-lg px-2 py-1 text-slate-500 hover:text-red-400"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <select
                value={u.locationId ?? ""}
                onChange={(e) => patch(u, { locationId: e.target.value || null })}
                className={SEL}
              >
                <option value="">{terms.location.singular}</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <select
                value={u.utilizedByEntityId ?? ""}
                onChange={(e) => patch(u, { utilizedByEntityId: e.target.value || null })}
                disabled={!!u.assignment}
                title={
                  u.assignment
                    ? "Set by the current check-out. Check the unit in to change it."
                    : undefined
                }
                className={`${SEL} disabled:opacity-50`}
              >
                <option value="">Assigned to</option>
                {entities.map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.name}
                  </option>
                ))}
              </select>
            </div>

            {u.assignment ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-slate-800/60 px-3 py-2">
                <span className="text-sm text-slate-200">
                  Checked out to{" "}
                  <span className="font-medium text-slate-100">{u.assignment.entityName}</span>{" "}
                  <span className="text-slate-500">
                    since {fmtDate(u.assignment.checkedOutAt)}
                  </span>
                </span>
                <button
                  onClick={() => checkIn(u)}
                  disabled={busy}
                  className="ml-auto rounded-lg bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  Check in
                </button>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={checkoutEntity[u.id] ?? ""}
                  onChange={(e) =>
                    setCheckoutEntity((prev) => ({ ...prev, [u.id]: e.target.value }))
                  }
                  aria-label="Entity to check this unit out to"
                  className={SEL}
                >
                  <option value="">Check out to</option>
                  {entities.map((en) => (
                    <option key={en.id} value={en.id}>
                      {en.name}
                      {en.kind ? ` (${en.kind})` : ""}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => checkOut(u)}
                  disabled={busy || !checkoutEntity[u.id]}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  Check out
                </button>
              </div>
            )}
            <UnitTagActions item={item} unit={u} onChange={onChange} />
          </div>
        ))}
        {item.units.length === 0 && (
          <p className="text-sm text-slate-500">
            No units yet. Add one per physical unit to track them individually. Each gets its own
            printable code and an optional label, and quantity follows the unit count.
          </p>
        )}
      </div>

      <form onSubmit={add} className="mt-2 flex flex-wrap gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label, such as Unit 1"
          className={`${SEL} flex-1`}
        />
        <input
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          placeholder="Scan/type a serial (optional)…"
          className={`${SEL} flex-1 font-mono`}
        />
        <button
          disabled={busy}
          className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          Add unit
        </button>
      </form>
      {err && <p className="mt-1 text-sm text-red-400">{err}</p>}
    </section>
  );
}
