import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { BUTTON, FIELD } from "../../components/ui";
import { suppliesApi } from "./api";
import { Badge, CARD, LocationSelect, Notice, PageHeader, errText, fmtQty, useScanTo } from "./shared";
import type { CountResult } from "./types";

type Line = { itemId: string; name: string; unit: string; onFile: number; counted: string };

/**
 * A cycle count of one location. Everything on file there is listed; scanning
 * a supply adds it if it is not, and jumps to its line. Saving sets each
 * counted level to what was found and records the variance.
 */
export function CountPage() {
  const terms = useTerms();
  const loc = terms.location.singular.toLowerCase();
  const [params] = useSearchParams();
  const [locationId, setLocationId] = useState(params.get("location") ?? "");
  const [lines, setLines] = useState<Line[]>([]);
  const [blind, setBlind] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CountResult | null>(null);

  const load = useCallback(async (id: string) => {
    setResult(null);
    setErr(null);
    if (!id) return setLines([]);
    try {
      const stock = await suppliesApi.locationStock(id);
      setLines(stock.items.map((i) => ({ itemId: i.itemId, name: i.name, unit: i.unit, onFile: i.qty, counted: "" })));
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void load(locationId);
  }, [locationId, load]);

  const focusLine = (itemId: string) =>
    setTimeout(() => document.getElementById(`count-${itemId}`)?.focus(), 0);

  useScanTo(async (code) => {
    setErr(null);
    try {
      const { match, consumable } = await suppliesApi.lookup(code);
      if (match?.kind === "location") {
        setLocationId(match.locationId!);
        return;
      }
      if (!match || match.kind === "unknown") return setErr(`Nothing matches ${code}.`);
      if (!consumable) return setErr(`${match.name ?? code} is not tracked as a supply.`);
      if (!locationId) return setErr(`Pick the ${loc} you are counting first.`);
      setLines((cur) =>
        cur.some((l) => l.itemId === consumable.itemId)
          ? cur
          : [
              ...cur,
              {
                itemId: consumable.itemId,
                name: consumable.name,
                unit: consumable.unit,
                onFile: consumable.levels.find((l) => l.locationId === locationId)?.qty ?? 0,
                counted: "",
              },
            ],
      );
      focusLine(consumable.itemId);
    } catch (e) {
      setErr(errText(e));
    }
  }, "one");

  const filled = lines.filter((l) => l.counted.trim() !== "");

  const save = async () => {
    const parsed = filled.map((l) => ({ itemId: l.itemId, countedQty: Number(l.counted.replace(",", ".")) }));
    if (parsed.some((p) => !Number.isFinite(p.countedQty) || p.countedQty < 0)) {
      return setErr("Counts have to be zero or more.");
    }
    setBusy(true);
    setErr(null);
    try {
      setResult(await suppliesApi.count(locationId, parsed, note.trim()));
      setNote("");
      const stock = await suppliesApi.locationStock(locationId);
      setLines(stock.items.map((i) => ({ itemId: i.itemId, name: i.name, unit: i.unit, onFile: i.qty, counted: "" })));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Count stock" back="/supplies" />
      <div className={`${CARD} space-y-3`}>
        <LocationSelect label={`${terms.location.singular} being counted`} value={locationId} onChange={setLocationId} />
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
          Hide what is on file while counting
        </label>
      </div>

      {locationId && (
        <div className={CARD}>
          {lines.length === 0 ? (
            <p className="text-sm text-slate-500">
              No supplies are on file here yet. Scan one to count it.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {lines.map((l) => (
                <li key={l.itemId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-100">{l.name}</p>
                    {!blind && (
                      <p className="text-xs text-slate-500">
                        On file: {fmtQty(l.onFile)} {l.unit}
                      </p>
                    )}
                  </div>
                  <input
                    id={`count-${l.itemId}`}
                    value={l.counted}
                    onChange={(e) =>
                      setLines((cur) => cur.map((x) => (x.itemId === l.itemId ? { ...x, counted: e.target.value } : x)))
                    }
                    inputMode="decimal"
                    placeholder="Counted"
                    aria-label={`Counted ${l.name}`}
                    className={`${FIELD} w-28 text-right`}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              aria-label="Note"
              className={`${FIELD} flex-1`}
            />
            <button onClick={save} disabled={busy || filled.length === 0} className={BUTTON}>
              {busy ? "Saving…" : `Save ${filled.length || ""} count${filled.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      {err && <Notice tone="error">{err}</Notice>}
      {result && (
        <div className={CARD}>
          <p className="text-sm text-slate-300">Counted at {result.locationName}:</p>
          <ul className="mt-2 divide-y divide-slate-800 text-sm">
            {result.lines.map((l) => (
              <li key={l.itemId} className="flex items-center justify-between py-1.5">
                <span className="text-slate-100">{l.itemName}</span>
                <span className="flex items-center gap-2 text-slate-400">
                  {fmtQty(l.expectedQty)} → {fmtQty(l.countedQty)} {l.unit}
                  {l.variance === 0 ? (
                    <Badge tone="ok">Matches</Badge>
                  ) : (
                    <Badge tone={l.variance < 0 ? "late" : "low"}>
                      {l.variance > 0 ? "+" : ""}
                      {fmtQty(l.variance)}
                    </Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
