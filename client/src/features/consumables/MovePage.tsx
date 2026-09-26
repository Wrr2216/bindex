import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { BUTTON, FIELD } from "../../components/ui";
import { suppliesApi } from "./api";
import {
  CARD,
  HolderSelect,
  LocationSelect,
  Notice,
  PageHeader,
  errText,
  fmtQty,
  useHolders,
  useScanTo,
} from "./shared";
import type { CatalogRow, ConsumableDetail, MovementPayload, StockReason } from "./types";

type Reason = Exclude<StockReason, "count">;

const TITLES: Record<Reason, string> = {
  receive: "Receive stock",
  issue: "Issue supplies",
  return: "Return unused supplies",
  consume: "Record use",
  transfer: "Transfer stock",
  adjust: "Adjust stock",
};

const DONE: Record<Reason, string> = {
  receive: "Received",
  issue: "Issued",
  return: "Returned",
  consume: "Recorded use of",
  transfer: "Transferred",
  adjust: "Adjusted",
};

const LAST_LOCATION = "bindex.supplies.location";
const LAST_HOLDER = "bindex.supplies.holder";

function remember(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the picker just starts empty next time.
  }
}
function recall(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/**
 * One screen for every stock movement, built to be quick on a phone: scan the
 * supply (or a shelf label to pick the location), type a quantity, done. The
 * location and holder stay put between entries.
 */
export function MovePage() {
  const { reason: raw } = useParams<{ reason: string }>();
  const reason = raw as Reason;
  const [params] = useSearchParams();
  const terms = useTerms();
  const { user } = useAuth();
  const { holders } = useHolders();
  const loc = terms.location.singular.toLowerCase();

  const [item, setItem] = useState<ConsumableDetail | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CatalogRow[]>([]);
  const [locationId, setLocationId] = useState(params.get("location") ?? recall(LAST_LOCATION));
  const [toLocationId, setToLocationId] = useState("");
  const [holderId, setHolderId] = useState(params.get("holder") ?? recall(LAST_HOLDER));
  const [fromHolder, setFromHolder] = useState(params.get("from") === "holder");
  const [qty, setQty] = useState("");
  const [sign, setSign] = useState<1 | -1>(1);
  const [jobRef, setJobRef] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const qtyRef = useRef<HTMLInputElement>(null);

  const pickItem = useCallback(async (itemId: string) => {
    setErr(null);
    try {
      setItem(await suppliesApi.detail(itemId));
      setQ("");
      setResults([]);
      setTimeout(() => qtyRef.current?.focus(), 0);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    const id = params.get("item");
    if (id) void pickItem(id);
  }, [params, pickItem]);

  useEffect(() => {
    if (item || !q.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      suppliesApi.catalog(q.trim()).then(setResults).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, item]);

  const onScan = useCallback(
    async (code: string) => {
      setErr(null);
      setDone(null);
      try {
        const { match } = await suppliesApi.lookup(code);
        if (!match || match.kind === "unknown") {
          setErr(`Nothing matches ${code}.`);
        } else if (match.kind === "location") {
          if (reason === "transfer" && locationId && !toLocationId && match.locationId !== locationId) {
            setToLocationId(match.locationId!);
          } else {
            setLocationId(match.locationId!);
          }
        } else if (!match.consumable) {
          setErr(`${match.name ?? code} is not tracked as a supply. Add it under Supplies first.`);
        } else {
          await pickItem(match.itemId!);
        }
      } catch (e) {
        setErr(errText(e));
      }
    },
    [reason, locationId, toLocationId, pickItem],
  );
  useScanTo((code) => void onScan(code), "one");

  if (!Object.hasOwn(TITLES, reason)) return <Navigate to="/supplies" replace />;
  if (reason === "adjust" && user?.role !== "admin") {
    return (
      <div className="space-y-4">
        <PageHeader title={TITLES.adjust} back="/supplies" />
        <Notice tone="warn">
          Only an administrator can adjust stock. <Link to="/supplies/count" className="underline">Count it</Link>{" "}
          instead and the level is set to what you find.
        </Notice>
      </div>
    );
  }

  const usesHolder = reason === "issue" || reason === "return" || reason === "consume";
  const holderRequired = reason === "issue" || reason === "return" || (reason === "consume" && fromHolder);
  const usesLocation = !(reason === "consume" && fromHolder);
  const locationLabel = {
    receive: `Into ${loc}`,
    issue: `From ${loc}`,
    return: `Back into ${loc}`,
    consume: `Used from ${loc}`,
    transfer: `From ${loc}`,
    adjust: `At ${loc}`,
  }[reason];
  const holderLabel = {
    issue: "Issue to",
    return: "Returned by",
    consume: fromHolder ? "Used by" : "Used by (optional)",
  }[reason as "issue" | "return" | "consume"];

  const onHandHere = item?.levels.find((l) => l.locationId === locationId)?.qty ?? 0;
  const holderBalance = item?.holders.find((h) => h.holderId === holderId)?.balance ?? 0;
  const holderName = holders.find((h) => h.id === holderId)?.name;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!item) return setErr("Scan or pick a supply first.");
    const n = Number(qty.replace(",", "."));
    if (!qty.trim() || !Number.isFinite(n) || n <= 0) return setErr("Enter a quantity above zero.");
    setBusy(true);
    setErr(null);
    setDone(null);
    const payload: MovementPayload = {
      reason,
      itemId: item.itemId,
      qty: reason === "adjust" ? null : n,
      delta: reason === "adjust" ? sign * n : null,
      locationId: usesLocation ? locationId || null : null,
      toLocationId: reason === "transfer" ? toLocationId || null : null,
      holderId: usesHolder ? holderId || null : null,
      jobRef: jobRef.trim() || null,
      note: note.trim() || null,
    };
    try {
      const res = await suppliesApi.move(payload);
      remember(LAST_LOCATION, locationId);
      remember(LAST_HOLDER, holderId);
      const fresh = await suppliesApi.detail(item.itemId);
      setItem(fresh);
      const after = res.levels.find((l) => l.locationId === payload.locationId);
      const where = after
        ? ` ${fmtQty(after.qty)} ${item.unit} now at ${fresh.levels.find((l) => l.locationId === after.locationId)?.locationName ?? `that ${loc}`}.`
        : "";
      const who =
        payload.holderId && holderName
          ? ` ${reason === "return" ? "from" : reason === "issue" ? "to" : "by"} ${holderName}`
          : "";
      setDone(`${DONE[reason]} ${fmtQty(n)} ${item.unit} of ${item.name}${who}.${where}`);
      setQty("");
      setNote("");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={TITLES[reason]} back="/supplies" />
      <p className="text-sm text-slate-400">
        Scan the supply with your reader or the camera, or search for it. Scanning a {loc} label picks the {loc}.
      </p>

      <form onSubmit={submit} className={`${CARD} space-y-4`}>
        {item ? (
          <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-800/60 px-3 py-2">
            <div className="min-w-0">
              <Link to={`/supplies/items/${item.itemId}`} className="font-medium text-slate-100 hover:underline">
                {item.name}
              </Link>
              <p className="text-xs text-slate-400">
                {fmtQty(item.onHand)} {item.unit} on hand in total
                {locationId && usesLocation && ` · ${fmtQty(onHandHere)} here`}
                {usesHolder && holderId && ` · ${fmtQty(holderBalance)} out with ${holderName ?? "them"}`}
              </p>
            </div>
            <button type="button" onClick={() => setItem(null)} className="text-xs text-slate-400 hover:text-slate-100">
              Change
            </button>
          </div>
        ) : (
          <div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Scan, or type to search supplies"
              aria-label="Search supplies"
              className={FIELD}
              autoFocus
            />
            {results.length > 0 && (
              <ul className="mt-1 divide-y divide-slate-800 rounded-lg border border-slate-800">
                {results.slice(0, 8).map((r) => (
                  <li key={r.itemId}>
                    <button
                      type="button"
                      onClick={() => void pickItem(r.itemId)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-800"
                    >
                      <span className="text-slate-100">{r.name}</span>
                      <span className="text-slate-500">
                        {fmtQty(r.onHand)} {r.unit}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {reason === "consume" && (
          <div className="flex gap-2 text-sm" role="radiogroup" aria-label="Used from">
            {[
              { v: false, label: `Straight from a ${loc}` },
              { v: true, label: "Out of what was issued" },
            ].map((o) => (
              <button
                key={String(o.v)}
                type="button"
                role="radio"
                aria-checked={fromHolder === o.v}
                onClick={() => setFromHolder(o.v)}
                className={`rounded-lg border px-3 py-1.5 ${
                  fromHolder === o.v ? "border-sky-600 bg-sky-950 text-sky-200" : "border-slate-700 text-slate-300"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {usesLocation && <LocationSelect label={locationLabel} value={locationId} onChange={setLocationId} />}
          {reason === "transfer" && (
            <LocationSelect label={`To ${loc}`} value={toLocationId} onChange={setToLocationId} exclude={locationId} />
          )}
          {usesHolder && (
            <HolderSelect
              label={holderLabel}
              value={holderId}
              onChange={setHolderId}
              holders={holders}
              placeholder={holderRequired ? "Choose…" : "Nobody in particular"}
            />
          )}
        </div>

        <div className="flex items-end gap-2">
          {reason === "adjust" && (
            <div className="flex overflow-hidden rounded-lg border border-slate-700" role="radiogroup" aria-label="Direction">
              {([1, -1] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={sign === s}
                  onClick={() => setSign(s)}
                  className={`px-4 py-2 text-lg ${sign === s ? "bg-sky-700 text-white" : "text-slate-300"}`}
                >
                  {s === 1 ? "+" : "−"}
                </button>
              ))}
            </div>
          )}
          <label className="block flex-1">
            <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">
              Quantity{item ? ` (${item.unit})` : ""}
            </span>
            <input
              ref={qtyRef}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="decimal"
              placeholder="0"
              aria-label="Quantity"
              className={`${FIELD} mt-1 text-lg`}
            />
          </label>
          <button disabled={busy || !item} className={`${BUTTON} py-2.5`}>
            {busy ? "Saving…" : "Done"}
          </button>
        </div>

        {(reason === "issue" || reason === "consume") && (
          <input
            value={jobRef}
            onChange={(e) => setJobRef(e.target.value)}
            placeholder="Job or reference (optional)"
            aria-label="Job reference"
            className={FIELD}
          />
        )}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={reason === "adjust" ? "Why is the stock being adjusted? (required)" : "Note (optional)"}
          aria-label="Note"
          className={FIELD}
        />
      </form>

      {done && <Notice tone="ok">{done}</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}
