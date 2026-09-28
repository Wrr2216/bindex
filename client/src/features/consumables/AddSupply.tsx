import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { BUTTON, FIELD, Field } from "../../components/ui";
import type { Item } from "../../types";
import { suppliesApi } from "./api";
import { CARD, H2, Notice, PageHeader, errText, useScanTo } from "./shared";

/**
 * Start counting something as a supply: pick an existing record or create a
 * new one, then say how it is counted. Scanning a barcode does either.
 */
export function AddSupply() {
  const terms = useTerms();
  const navigate = useNavigate();
  const itemWord = terms.item.singular.toLowerCase();
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [picked, setPicked] = useState<Item | null>(null);
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [cost, setCost] = useState("");
  const [unit, setUnit] = useState("each");
  const [reorderPoint, setReorderPoint] = useState("");
  const [reorderQty, setReorderQty] = useState("");
  const [supplier, setSupplier] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "existing" || picked || !q.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api.listItems({ q: q.trim() }).then(setResults).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, mode, picked]);

  useScanTo(async (code) => {
    setErr(null);
    try {
      const { match } = await suppliesApi.lookup(code);
      if (match?.kind === "item" && match.itemId) {
        if (match.consumable) return navigate(`/supplies/items/${match.itemId}`);
        setMode("existing");
        setPicked(await api.getItem(match.itemId));
      } else {
        setMode("new");
        setBarcode(code);
      }
    } catch (e) {
      setErr(errText(e));
    }
  }, "one");

  const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const rp = num(reorderPoint);
    const rq = num(reorderQty);
    if ([rp, rq].some((n) => n !== null && (!Number.isFinite(n) || n < 0))) {
      return setErr("Reorder numbers have to be zero or more.");
    }
    setBusy(true);
    try {
      let itemId = picked?.id;
      if (mode === "new") {
        if (!name.trim()) throw new Error("Give the supply a name.");
        const cents = num(cost);
        const code = barcode.trim();
        const created = await api.createItem({
          name: name.trim(),
          valueCents: cents === null || !Number.isFinite(cents) ? null : Math.round(cents * 100),
          identifiers: code ? [{ type: /^\d{8,14}$/.test(code) ? "upc" : "sku", value: code }] : [],
        });
        itemId = created.id;
      }
      if (!itemId) throw new Error(`Pick the ${itemWord} to track.`);
      await suppliesApi.saveSettings(itemId, {
        unit: unit.trim() || "each",
        reorderPoint: rp,
        reorderQty: rq,
        supplier: supplier.trim() || null,
      });
      navigate(`/supplies/items/${itemId}`);
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const tab = (m: "existing" | "new", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => setMode(m)}
      className={`rounded-lg px-3 py-1.5 text-sm ${mode === m ? "bg-slate-800 text-sky-300" : "text-slate-400 hover:text-slate-200"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Add a supply" back="/supplies" />
      <p className="text-sm text-slate-400">
        Scan its barcode, or fill it in. Boxes, tape, pads and stretch wrap are counted by quantity; equipment such as
        dollies and straps stays an ordinary {itemWord} and goes out in kits.
      </p>

      <form onSubmit={save} className={`${CARD} space-y-4`}>
        <div className="flex gap-1" role="tablist">
          {tab("new", "New supply")}
          {tab("existing", `Existing ${itemWord}`)}
        </div>

        {mode === "new" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD} placeholder="Packing tape" />
            </Field>
            <Field label="Barcode" hint="Optional">
              <input value={barcode} onChange={(e) => setBarcode(e.target.value)} className={FIELD} />
            </Field>
            <Field label="Cost per unit" hint="Used for usage cost">
              <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" className={FIELD} placeholder="2.50" />
            </Field>
          </div>
        ) : picked ? (
          <div className="flex items-center justify-between rounded-lg bg-slate-800/60 px-3 py-2">
            <span className="text-slate-100">
              {picked.name} <span className="text-sm text-slate-500">{picked.assetCode}</span>
            </span>
            <button type="button" onClick={() => setPicked(null)} className="text-xs text-slate-400 hover:text-slate-100">
              Change
            </button>
          </div>
        ) : (
          <div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${terms.item.plural.toLowerCase()}`}
              aria-label={`Search ${terms.item.plural.toLowerCase()}`}
              className={FIELD}
            />
            {results.length > 0 && (
              <ul className="mt-1 divide-y divide-slate-800 rounded-lg border border-slate-800">
                {results.slice(0, 8).map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(r)}
                      className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-800"
                    >
                      <span className="text-slate-100">{r.name}</span>
                      <span className="text-slate-500">{r.assetCode}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <h2 className={H2}>How it is counted</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Unit" hint="each, box, roll, ft…">
            <input value={unit} onChange={(e) => setUnit(e.target.value)} className={FIELD} />
          </Field>
          <Field label="Reorder point" hint="Low at or below">
            <input value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} inputMode="decimal" className={FIELD} />
          </Field>
          <Field label="Reorder quantity">
            <input value={reorderQty} onChange={(e) => setReorderQty(e.target.value)} inputMode="decimal" className={FIELD} />
          </Field>
          <Field label="Supplier">
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className={FIELD} />
          </Field>
        </div>
        <button disabled={busy} className={BUTTON}>
          {busy ? "Saving…" : "Start tracking"}
        </button>
      </form>
      {err && <Notice tone="error">{err}</Notice>}
    </div>
  );
}
