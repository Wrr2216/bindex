import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BUTTON, BUTTON_QUIET, FIELD } from "../../components/ui";
import { suppliesApi } from "./api";
import {
  Badge,
  CARD,
  H2,
  Notice,
  PageHeader,
  SMALL_BUTTON,
  dateInputValue,
  errText,
  fmtQty,
  fmtWhen,
  kindLabel,
  localDay,
  startOfToday,
  useScanTo,
} from "./shared";
import { MovementList } from "./SupplyDetail";
import type { DescribedCode, EquipmentRow, HolderDetail, ReturnResult } from "./types";

function EquipmentList({ rows, back }: { rows: EquipmentRow[]; back?: boolean }) {
  return (
    <ul className="mt-2 divide-y divide-slate-800">
      {rows.map((r) => (
        <li key={r.assignmentId} className="flex items-center justify-between gap-3 py-2 text-sm">
          <div className="min-w-0">
            <Link to={`/items/${r.itemId}${r.unitId ? `?unit=${r.unitId}` : ""}`} className="truncate text-slate-100 hover:underline">
              {r.name}
              {r.unitLabel && <span className="ml-2 text-slate-400">{r.unitLabel}</span>}
            </Link>
            <p className="text-xs text-slate-500">
              {r.assetCode} · out {fmtWhen(r.checkedOutAt)}
              {r.kitId && (
                <>
                  {" · "}
                  <Link to={`/supplies/kits/${r.kitId}`} className="hover:underline">
                    kit{r.jobRef ? ` ${r.jobRef}` : ""}
                  </Link>
                </>
              )}
            </p>
          </div>
          {back ? (
            <span className="shrink-0 text-xs text-slate-400">Back {fmtWhen(r.checkedInAt)}</span>
          ) : r.overdue ? (
            <Badge tone="late">Overdue since {fmtWhen(r.expectedReturnAt)}</Badge>
          ) : (
            <Badge tone="low">Still out{r.expectedReturnAt ? `, due ${fmtWhen(r.expectedReturnAt)}` : ""}</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Everything one crew, truck or branch is accountable for, and the end-of-day
 * return: scan what came back, then see exactly what is still out.
 */
export function HolderPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [day, setDay] = useState(dateInputValue(startOfToday()));
  const [d, setD] = useState<HolderDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState<DescribedCode[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReturnResult | null>(null);
  const seen = useRef(new Set<string>());

  const load = useCallback(() => {
    suppliesApi
      .holder(id, localDay(day).toISOString())
      .then(setD)
      .catch((e) => setErr(errText(e)));
  }, [id, day]);
  useEffect(load, [load]);

  const add = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code || seen.current.has(code)) return;
    seen.current.add(code);
    try {
      const [r] = await suppliesApi.resolve([code]);
      if (r) setScanned((cur) => [r, ...cur]);
    } catch (e) {
      seen.current.delete(code);
      setErr(errText(e));
    }
  }, []);
  useScanTo((code) => void add(code), "bulk", scanning);

  const items = scanned.filter((s) => s.kind === "item" && !s.consumable);
  const checkIn = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await suppliesApi.returnEquipment({
        holderId: id,
        lines: items.map((s) => ({ itemId: s.itemId!, unitId: s.unitId })),
      });
      setResult(res);
      setScanned([]);
      seen.current.clear();
      setScanning(false);
      load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!d) {
    return err ? (
      <div className="space-y-4">
        <PageHeader title="Crew, truck or branch" back="/supplies" />
        <Notice tone="error">{err}</Notice>
      </div>
    ) : (
      <p className="py-10 text-center text-slate-500">Loading…</p>
    );
  }

  const eq = d.equipment;
  const out = (reason: string, itemId: string) => `/supplies/move/${reason}?item=${itemId}&holder=${d.holder.id}`;

  return (
    <div className="space-y-4">
      <PageHeader title={d.holder.name} back="/supplies">
        <Link to={`/supplies/kits/new?holder=${d.holder.id}`} className={SMALL_BUTTON}>
          Check out a kit
        </Link>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
        {d.holder.kind && <span>{kindLabel(d.holder.kind)}</span>}
        <label className="flex items-center gap-2">
          Since
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={`${FIELD} w-auto py-1`} />
        </label>
      </div>

      <section className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={H2}>Equipment</h2>
          <div className="flex gap-3 text-sm">
            <span className="text-slate-300">{eq.wentOut.length} went out</span>
            <span className="text-slate-300">{eq.cameBack.length} came back</span>
            <span className={eq.stillOut.length ? "text-red-300" : "text-emerald-400"}>{eq.stillOut.length} still out</span>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-slate-800 p-3">
          {scanning ? (
            <>
              <p className="text-sm text-slate-300">
                Scan each piece coming back. <span className="text-sky-300">{scanned.length}</span> read.
              </p>
              {scanned.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {scanned.map((s) => (
                    <li key={s.code} className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-200">{s.name ?? s.code}</span>
                      {s.kind !== "item" ? (
                        <Badge tone="late">No match</Badge>
                      ) : s.consumable ? (
                        <Badge tone="late">Supply: use Return</Badge>
                      ) : !s.outTo ? (
                        <Badge tone="muted">Not out</Badge>
                      ) : s.outTo.holderId !== d.holder.id ? (
                        <Badge tone="low">Out to {s.outTo.holderName}</Badge>
                      ) : (
                        <Badge tone="ok">Out to them</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                <button onClick={checkIn} disabled={busy || items.length === 0} className={BUTTON}>
                  {busy ? "Checking in…" : `Check in ${items.length}`}
                </button>
                <button
                  onClick={() => {
                    setScanning(false);
                    setScanned([]);
                    seen.current.clear();
                  }}
                  className={BUTTON_QUIET}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={() => {
                setResult(null);
                setScanning(true);
              }}
              className={BUTTON}
            >
              Start end-of-day return
            </button>
          )}
        </div>

        {result && (
          <div className="mt-3 space-y-2">
            <Notice tone={result.stillOut.length || result.notOut.length ? "warn" : "ok"}>
              Checked in {result.returned.length}.{" "}
              {result.stillOut.length
                ? `${result.stillOut.length} still out: ${result.stillOut.map((r) => r.name).join(", ")}.`
                : "Nothing is still out."}
            </Notice>
            {result.returned.some((r) => r.wrongHolder) && (
              <Notice tone="warn">
                Taken back, but they were out to someone else:{" "}
                {result.returned
                  .filter((r) => r.wrongHolder)
                  .map((r) => `${r.name} (${r.fromHolderName})`)
                  .join(", ")}
                .
              </Notice>
            )}
            {result.notOut.length > 0 && (
              <Notice tone="warn">
                Not checked out, nothing to do: {result.notOut.map((r) => r.name ?? r.itemId).join(", ")}.
              </Notice>
            )}
          </div>
        )}

        {eq.stillOut.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-medium text-red-300">Still out</h3>
            <EquipmentList rows={eq.stillOut} />
          </>
        )}
        {eq.cameBack.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-medium text-slate-300">Came back</h3>
            <EquipmentList rows={eq.cameBack} back />
          </>
        )}
        {eq.stillOut.length + eq.cameBack.length === 0 && (
          <p className="mt-3 text-sm text-slate-500">No equipment out or returned in this period.</p>
        )}
      </section>

      <section className={CARD}>
        <h2 className={H2}>Supplies they have</h2>
        {d.supplies.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nothing issued and not yet returned or used.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800 text-sm">
            {d.supplies.map((s) => (
              <li key={s.itemId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link to={`/supplies/items/${s.itemId}`} className="text-slate-100 hover:underline">
                  {s.itemName}
                </Link>
                <span className="flex items-center gap-2">
                  <span className="text-slate-200">
                    {fmtQty(s.balance)} {s.unit}
                  </span>
                  <Link to={out("return", s.itemId)} className={SMALL_BUTTON}>
                    Return
                  </Link>
                  <Link to={`${out("consume", s.itemId)}&from=holder`} className={SMALL_BUTTON}>
                    Used
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        )}
        <h3 className="mt-4 text-sm font-medium text-slate-300">Supply movements in this period</h3>
        <MovementList movements={d.movements} showItem />
      </section>

      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}
