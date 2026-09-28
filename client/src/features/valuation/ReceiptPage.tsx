import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { ArrowLeftIcon } from "../../components/icons";
import { useTerms } from "../../config/useConfig";
import type { Item } from "../../types";
import { AttachmentGallery } from "../media-ai-core/AttachmentGallery";
import { valuationApi } from "./api";
import { BTN, BTN_PRIMARY, CARD, FIELD, LABEL, Pill, centsToInput, errorText, formatDay, parseMoneyInput, useMoneyExact } from "./format";
import type { ConfirmResult, LineProposal, Receipt, ReceiptLine, ValuationStatus } from "./types";

type EditLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  total: string;
  sku: string;
  serial: string;
  warrantyMonths: string;
};

const toEdit = (l: ReceiptLine): EditLine => ({
  description: l.description,
  quantity: String(l.quantity),
  unitPrice: centsToInput(l.unitPriceCents),
  total: centsToInput(l.totalCents),
  sku: l.sku ?? "",
  serial: l.serial ?? "",
  warrantyMonths: l.warrantyMonths?.toString() ?? "",
});

const BLANK: EditLine = { description: "", quantity: "1", unitPrice: "", total: "", sku: "", serial: "", warrantyMonths: "" };

/** "none", "create", or "<itemId>|<unitId>". */
type Choice = string;
type Decision = { choice: Choice; setValue: boolean; extra: { value: Choice; label: string }[] };

function FindItem({ onPick }: { onPick: (item: Item) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Item[]>([]);
  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => api.listItems({ q: q.trim(), kind: "physical" }).then((r) => setHits(r.slice(0, 5))).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="mt-1">
      <input className={`${FIELD} py-1`} placeholder="Find another…" value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="text-left text-xs text-sky-400 hover:underline"
                onClick={() => {
                  onPick(h);
                  setQ("");
                }}
              >
                {h.name} {h.model ? `(${h.model})` : ""} · {h.assetCode}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One receipt: its photo or PDF, the lines read from it (by AI or by hand),
 * and which item each line bought. Confirming saves the purchase date, price
 * paid and vendor on every matched item, and the warranty when a line states
 * one.
 */
export function ReceiptPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const preferItemId = params.get("item");
  const navigate = useNavigate();
  const { user } = useAuth();
  const terms = useTerms();
  const money = useMoneyExact();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [status, setStatus] = useState<ValuationStatus | null>(null);
  const [head, setHead] = useState({ vendor: "", purchaseDate: "", currency: "", subtotal: "", tax: "", total: "" });
  const [lines, setLines] = useState<EditLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [proposals, setProposals] = useState<LineProposal[] | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [fileCount, setFileCount] = useState(0);

  const adopt = useCallback((r: Receipt) => {
    setReceipt(r);
    setHead({
      vendor: r.vendor ?? "",
      purchaseDate: r.purchaseDate ?? "",
      currency: r.currency ?? "",
      subtotal: centsToInput(r.subtotalCents),
      tax: centsToInput(r.taxCents),
      total: centsToInput(r.totalCents),
    });
    setLines(r.lines.map(toEdit));
    setDirty(false);
    if (r.reading?.warnings) setWarnings(r.reading.warnings);
  }, []);

  const loadMatches = useCallback(
    async (r: Receipt) => {
      if (r.status !== "draft" || !r.lines.length) {
        setProposals(null);
        return;
      }
      const list = await valuationApi.matches(r.id, preferItemId);
      setProposals(list);
      const next: Record<string, Decision> = {};
      r.lines.forEach((l, i) => {
        const s = list[i]?.suggested;
        next[l.id] = { choice: s ? `${s.itemId}|${s.unitId ?? ""}` : "none", setValue: false, extra: [] };
      });
      setDecisions(next);
    },
    [preferItemId],
  );

  useEffect(() => {
    valuationApi
      .receipt(id)
      .then(async (r) => {
        adopt(r);
        await loadMatches(r);
      })
      .catch((err) => setError(errorText(err, "Could not load the receipt.")));
    valuationApi.status().then(setStatus).catch(() => setStatus(null));
  }, [id, adopt, loadMatches]);

  if (!receipt) return <p className="py-10 text-center text-slate-500">{error ?? "Loading…"}</p>;
  const draft = receipt.status === "draft";

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err, "That did not work."));
    } finally {
      setBusy(null);
    }
  };

  const read = () =>
    run("read", async () => {
      const r = await valuationApi.readReceipt(receipt.id);
      if (!r.available) setMessage("Reading receipts needs a vision model; none is configured. Enter the lines by hand.");
      else if (!r.found) setMessage(r.message ?? "Nothing could be read.");
      adopt(r.receipt);
      setWarnings(r.reading?.warnings ?? []);
      await loadMatches(r.receipt);
    });

  const cents = (s: string) => (s.trim() ? parseMoneyInput(s) : null);

  const save = () =>
    run("save", async () => {
      const r = await valuationApi.updateReceipt(receipt.id, {
        vendor: head.vendor.trim() || null,
        purchaseDate: head.purchaseDate || null,
        currency: head.currency.trim().toUpperCase() || null,
        subtotalCents: cents(head.subtotal),
        taxCents: cents(head.tax),
        totalCents: cents(head.total),
        lines: lines
          .filter((l) => l.description.trim())
          .map((l) => ({
            description: l.description.trim(),
            quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
            unitPriceCents: cents(l.unitPrice),
            totalCents: cents(l.total),
            sku: l.sku.trim() || null,
            serial: l.serial.trim() || null,
            warrantyMonths: l.warrantyMonths.trim() ? Math.round(Number(l.warrantyMonths)) : null,
          })),
      });
      adopt(r);
      await loadMatches(r);
    });

  const confirmAll = () =>
    run("confirm", async () => {
      if (dirty) throw new Error("Save your changes to the lines first.");
      const body = receipt.lines.map((l) => {
        const d = decisions[l.id] ?? { choice: "none", setValue: false };
        if (d.choice === "create") return { lineId: l.id, create: true, setValue: true };
        if (d.choice === "none") return { lineId: l.id, itemId: null };
        const [itemId, unitId] = d.choice.split("|");
        return { lineId: l.id, itemId, unitId: unitId || null, setValue: d.setValue };
      });
      const r = await valuationApi.confirmReceipt(receipt.id, body);
      setResult(r);
      adopt(r.receipt);
      setProposals(null);
    });

  const remove = () => {
    if (!confirm(draft ? "Delete this receipt and its files?" : "Delete this confirmed receipt? Items keep their purchase facts but lose the link.")) return;
    void run("delete", async () => {
      await valuationApi.deleteReceipt(receipt.id);
      navigate("/valuation?tab=receipts");
    });
  };

  const setLine = (i: number, patch: Partial<EditLine>) => {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  const setHeadField = (k: keyof typeof head, v: string) => {
    setHead((h) => ({ ...h, [k]: v }));
    setDirty(true);
  };

  return (
    <div className="space-y-5">
      <Link to="/valuation?tab=receipts" className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:underline">
        <ArrowLeftIcon className="h-3.5 w-3.5" />
        Receipts
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{receipt.vendor ?? "Receipt"}</h1>
          <p className="text-sm text-slate-400">
            {receipt.purchaseDate ? formatDay(receipt.purchaseDate) : "No date yet"}
            {receipt.totalCents != null ? ` · ${money(receipt.totalCents, receipt.currency)}` : ""}
            {receipt.confirmedAt ? ` · confirmed ${new Date(receipt.confirmedAt).toLocaleDateString()}${receipt.confirmedByName ? ` by ${receipt.confirmedByName}` : ""}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={draft ? "muted" : "ok"}>{draft ? "Draft" : "Confirmed"}</Pill>
          {(draft || user?.role === "admin") && (
            <button type="button" onClick={remove} className="text-sm text-slate-500 hover:text-red-400">
              Delete
            </button>
          )}
        </div>
      </div>

      <div className={CARD}>
        <AttachmentGallery
          ownerType="receipt"
          ownerId={receipt.id}
          kinds={["photo", "document"]}
          title="Receipt photo or PDF"
          readOnly={!draft}
          onChange={(list) => setFileCount(list.length)}
          headerActions={
            draft && status?.vision ? (
              <button type="button" className={BTN_PRIMARY} disabled={busy !== null || fileCount === 0} onClick={read}>
                {busy === "read" ? "Reading…" : "Read with AI"}
              </button>
            ) : null
          }
        />
        {draft && status?.vision && !status.pdfReceipts && (
          <p className="mt-2 text-xs text-slate-500">PDF receipts are stored but cannot be read here; photograph paper receipts for AI reading.</p>
        )}
        {draft && !status?.vision && <p className="mt-2 text-xs text-slate-500">Enter the lines below by hand.</p>}
      </div>

      {message && <p className="text-sm text-amber-300">{message}</p>}
      {warnings.length > 0 && draft && (
        <ul className="space-y-1 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-200">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div className={`${CARD} space-y-3`}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label>
            <span className={LABEL}>Vendor</span>
            <input className={`${FIELD} mt-1`} value={head.vendor} disabled={!draft} onChange={(e) => setHeadField("vendor", e.target.value)} />
          </label>
          <label>
            <span className={LABEL}>Purchase date {receipt.reading?.datePrinted ? `(printed "${receipt.reading.datePrinted}")` : ""}</span>
            <input type="date" className={`${FIELD} mt-1`} value={head.purchaseDate} disabled={!draft} onChange={(e) => setHeadField("purchaseDate", e.target.value)} />
          </label>
          <label>
            <span className={LABEL}>Currency</span>
            <input className={`${FIELD} mt-1`} value={head.currency} maxLength={3} disabled={!draft} onChange={(e) => setHeadField("currency", e.target.value)} />
          </label>
          <label>
            <span className={LABEL}>Subtotal</span>
            <input className={`${FIELD} mt-1`} inputMode="decimal" value={head.subtotal} disabled={!draft} onChange={(e) => setHeadField("subtotal", e.target.value)} />
          </label>
          <label>
            <span className={LABEL}>Tax</span>
            <input className={`${FIELD} mt-1`} inputMode="decimal" value={head.tax} disabled={!draft} onChange={(e) => setHeadField("tax", e.target.value)} />
          </label>
          <label>
            <span className={LABEL}>Total</span>
            <input className={`${FIELD} mt-1`} inputMode="decimal" value={head.total} disabled={!draft} onChange={(e) => setHeadField("total", e.target.value)} />
          </label>
        </div>

        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Lines</h2>
          {lines.length === 0 && <p className="text-sm text-slate-500">No lines yet.</p>}
          {lines.map((l, i) => {
            const saved = !dirty ? receipt.lines[i] : undefined;
            const proposal = saved && proposals ? proposals[i] : undefined;
            const decision = saved ? decisions[saved.id] : undefined;
            return (
              <div key={i} className="space-y-2 rounded-lg bg-slate-800/50 p-3">
                <div className="grid gap-2 sm:grid-cols-12">
                  <input aria-label="Description" className={`${FIELD} sm:col-span-5`} value={l.description} disabled={!draft} onChange={(e) => setLine(i, { description: e.target.value })} />
                  <input aria-label="Quantity" className={`${FIELD} sm:col-span-1`} inputMode="decimal" value={l.quantity} disabled={!draft} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                  <input aria-label="Unit price" placeholder="Each" className={`${FIELD} sm:col-span-2`} inputMode="decimal" value={l.unitPrice} disabled={!draft} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                  <input aria-label="Line total" placeholder="Total" className={`${FIELD} sm:col-span-2`} inputMode="decimal" value={l.total} disabled={!draft} onChange={(e) => setLine(i, { total: e.target.value })} />
                  <input aria-label="Warranty months" placeholder="Warranty (mo)" className={`${FIELD} sm:col-span-2`} inputMode="numeric" value={l.warrantyMonths} disabled={!draft} onChange={(e) => setLine(i, { warrantyMonths: e.target.value })} />
                  <input aria-label="Product code" placeholder="SKU / model" className={`${FIELD} sm:col-span-3`} value={l.sku} disabled={!draft} onChange={(e) => setLine(i, { sku: e.target.value })} />
                  <input aria-label="Serial" placeholder="Serial" className={`${FIELD} sm:col-span-3`} value={l.serial} disabled={!draft} onChange={(e) => setLine(i, { serial: e.target.value })} />
                  {draft && (
                    <button
                      type="button"
                      className="text-left text-xs text-slate-500 hover:text-red-400 sm:col-span-2"
                      onClick={() => {
                        setLines((ls) => ls.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                    >
                      Remove line
                    </button>
                  )}
                </div>

                {!draft && saved?.itemId && (
                  <p className="text-sm">
                    <span className="text-slate-400">Bought: </span>
                    <Link to={`/items/${saved.itemId}${saved.unitId ? `?unit=${saved.unitId}` : ""}`} className="text-sky-400 hover:underline">
                      {saved.itemName ?? `a deleted ${terms.item.singular.toLowerCase()}`}
                      {saved.unitLabel ? ` (${saved.unitLabel})` : ""}
                    </Link>
                  </p>
                )}

                {draft && saved && proposal && decision && (
                  <div className="grid gap-2 sm:grid-cols-12 sm:items-start">
                    <label className="sm:col-span-7">
                      <span className={LABEL}>Bought which {terms.item.singular.toLowerCase()}?</span>
                      <select
                        className={`${FIELD} mt-1`}
                        value={decision.choice}
                        onChange={(e) => setDecisions((d) => ({ ...d, [saved.id]: { ...decision, choice: e.target.value } }))}
                      >
                        <option value="none">Not matched (keep on the receipt only)</option>
                        {proposal.candidates.map((c) => (
                          <option key={`${c.itemId}|${c.unitId ?? ""}`} value={`${c.itemId}|${c.unitId ?? ""}`}>
                            {c.name} · {c.assetCode} ({c.explanation})
                          </option>
                        ))}
                        {decision.extra.map((x) => (
                          <option key={x.value} value={x.value}>
                            {x.label}
                          </option>
                        ))}
                        <option value="create">Create a new {terms.item.singular.toLowerCase()} from this line</option>
                      </select>
                      <FindItem
                        onPick={(item) =>
                          setDecisions((d) => ({
                            ...d,
                            [saved.id]: {
                              ...decision,
                              choice: `${item.id}|`,
                              extra: [...decision.extra, { value: `${item.id}|`, label: `${item.name} · ${item.assetCode}` }],
                            },
                          }))
                        }
                      />
                    </label>
                    {decision.choice !== "none" && decision.choice !== "create" && (
                      <label className="flex items-center gap-2 pt-6 text-sm text-slate-300 sm:col-span-5">
                        <input
                          type="checkbox"
                          checked={decision.setValue}
                          onChange={(e) => setDecisions((d) => ({ ...d, [saved.id]: { ...decision, setValue: e.target.checked } }))}
                        />
                        Also record the price paid as its value
                      </label>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {draft && (
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setLines((ls) => [...ls, { ...BLANK }]);
                setDirty(true);
              }}
            >
              Add line
            </button>
          )}
        </div>

        {draft && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
            <button type="button" className={BTN} disabled={!dirty || busy !== null} onClick={save}>
              {busy === "save" ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className={BTN_PRIMARY} disabled={dirty || busy !== null || !receipt.lines.length} onClick={confirmAll}>
              {busy === "confirm" ? "Confirming…" : "Confirm and save on items"}
            </button>
            {dirty && <span className="text-sm text-slate-400">Save the lines to see matches.</span>}
          </div>
        )}
      </div>

      {result && (
        <div className={`${CARD} space-y-1 text-sm`}>
          <p className="text-emerald-300">
            Saved on {result.matched.length} record{result.matched.length === 1 ? "" : "s"}
            {result.matched.some((m) => m.created) ? `, ${result.matched.filter((m) => m.created).length} created` : ""}.
          </p>
          {result.notes.map((n) => (
            <p key={n} className="text-amber-300">
              {n}
            </p>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
