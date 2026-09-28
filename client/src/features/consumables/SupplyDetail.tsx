import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET, FIELD, Field } from "../../components/ui";
import { suppliesApi } from "./api";
import { Badge, CARD, H2, Notice, PageHeader, SMALL_BUTTON, errText, fmtQty, fmtWhen, useCost } from "./shared";
import type { ConsumableDetail, Movement } from "./types";

const REASON_LABEL: Record<Movement["reason"], string> = {
  receive: "Received",
  issue: "Issued",
  return: "Returned",
  transfer: "Transferred",
  consume: "Used",
  adjust: "Adjusted",
  count: "Counted",
};

/** One line of history, in words: "Issued 5 roll from Warehouse to Crew 1". */
export function describeMovement(m: Movement): string {
  const qty = `${fmtQty(m.qty)} ${m.unit}`;
  const from = m.fromLocationName ? ` from ${m.fromLocationName}` : "";
  const to = m.toLocationName ? ` into ${m.toLocationName}` : "";
  const holder = m.holderName;
  switch (m.reason) {
    case "issue":
      return `Issued ${qty}${from}${holder ? ` to ${holder}` : ""}`;
    case "return":
      return `Returned ${qty}${holder ? ` from ${holder}` : ""}${to}`;
    case "consume":
      return m.holderDelta < 0
        ? `${holder ?? "Someone"} used ${qty} of what they were issued`
        : `Used ${qty}${from}${holder ? ` by ${holder}` : ""}`;
    case "count": {
      const at = m.toLocationName ?? m.fromLocationName;
      return `Counted ${fmtQty(m.countedQty ?? 0)} ${m.unit}${at ? ` at ${at}` : ""} (on file ${fmtQty(m.expectedQty ?? 0)})`;
    }
    case "adjust":
      return `Adjusted ${m.toLocationId ? "+" : "−"}${qty}${m.toLocationName ? ` at ${m.toLocationName}` : m.fromLocationName ? ` at ${m.fromLocationName}` : ""}`;
    case "transfer":
      return `Transferred ${qty}${from}${m.toLocationName ? ` to ${m.toLocationName}` : ""}`;
    default:
      return `${REASON_LABEL[m.reason]} ${qty}${to}`;
  }
}

export function MovementList({ movements, showItem }: { movements: Movement[]; showItem?: boolean }) {
  if (!movements.length) return <p className="mt-2 text-sm text-slate-500">Nothing recorded yet.</p>;
  return (
    <ul className="mt-2 divide-y divide-slate-800 text-sm">
      {movements.map((m) => (
        <li key={m.id} className="py-2">
          <div className="flex items-start justify-between gap-3">
            <span className="text-slate-200">
              {showItem && <span className="font-medium text-slate-100">{m.itemName}: </span>}
              {describeMovement(m)}
            </span>
            <span className="shrink-0 text-xs text-slate-500">{fmtWhen(m.createdAt)}</span>
          </div>
          {(m.jobRef || m.note || m.createdByName) && (
            <p className="text-xs text-slate-500">
              {[m.jobRef, m.note, m.createdByName && `by ${m.createdByName}`].filter(Boolean).join(" · ")}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SupplyDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const terms = useTerms();
  const cost = useCost();
  const [d, setD] = useState<ConsumableDetail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [unit, setUnit] = useState("");
  const [reorderPoint, setReorderPoint] = useState("");
  const [reorderQty, setReorderQty] = useState("");
  const [supplier, setSupplier] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const apply = (x: ConsumableDetail) => {
    setD(x);
    setUnit(x.unit);
    setReorderPoint(x.reorderPoint === null ? "" : String(x.reorderPoint));
    setReorderQty(x.reorderQty === null ? "" : String(x.reorderQty));
    setSupplier(x.supplier ?? "");
  };

  const load = useCallback(() => {
    suppliesApi
      .detail(id)
      .then(apply)
      .catch((e) => setMissing(errText(e)));
  }, [id]);
  useEffect(load, [load]);

  const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      apply(
        await suppliesApi.saveSettings(id, {
          unit: unit.trim() || "each",
          reorderPoint: num(reorderPoint),
          reorderQty: num(reorderQty),
          supplier: supplier.trim() || null,
        }),
      );
      setMsg({ tone: "ok", text: "Saved." });
    } catch (e2) {
      setMsg({ tone: "error", text: errText(e2) });
    } finally {
      setBusy(false);
    }
  };

  const untrack = async () => {
    if (!confirm("Stop tracking this as a supply? Its stock history is kept and comes back if you track it again.")) return;
    try {
      await suppliesApi.untrack(id);
      navigate("/supplies");
    } catch (e) {
      setMsg({ tone: "error", text: errText(e) });
    }
  };

  if (missing) {
    return (
      <div className="space-y-4">
        <PageHeader title="Supply" back="/supplies" />
        <Notice tone="error">{missing}</Notice>
      </div>
    );
  }
  if (!d) return <p className="py-10 text-center text-slate-500">Loading…</p>;

  const act = (reason: string) => `/supplies/move/${reason}?item=${d.itemId}`;

  return (
    <div className="space-y-5">
      <PageHeader title={d.name} back="/supplies">
        <Link to={`/items/${d.itemId}`} className={SMALL_BUTTON}>
          Open {terms.item.singular.toLowerCase()}
        </Link>
      </PageHeader>
      <p className="text-sm text-slate-400">
        {d.assetCode} · {fmtQty(d.onHand)} {d.unit} on hand
        {d.outstanding !== 0 && ` · ${fmtQty(d.outstanding)} out with crews`}
        {d.valueCents !== null && ` · ${cost(d.valueCents)} per ${d.unit}`}
        {d.low && (
          <span className="ml-2">
            <Badge tone="low">Low</Badge>
          </span>
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        {[
          ["receive", "Receive"],
          ["issue", "Issue"],
          ["return", "Return"],
          ["consume", "Record use"],
          ["transfer", "Transfer"],
        ].map(([r, label]) => (
          <Link key={r} to={act(r!)} className={SMALL_BUTTON}>
            {label}
          </Link>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={CARD}>
          <h2 className={H2}>By {terms.location.singular.toLowerCase()}</h2>
          {d.levels.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Not stocked anywhere yet. Receive some to start.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-800 text-sm">
              {d.levels.map((l) => (
                <li key={l.locationId} className="flex items-center justify-between py-1.5">
                  <Link to={`/supplies/count?location=${l.locationId}`} className="text-slate-200 hover:underline">
                    {l.locationName}
                  </Link>
                  <span className="flex items-center gap-2">
                    {l.low && <Badge tone="low">Low</Badge>}
                    <span className={l.qty < 0 ? "text-red-300" : "text-slate-100"}>
                      {fmtQty(l.qty)} {d.unit}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {d.holders.length > 0 && (
            <>
              <h2 className={`${H2} mt-4`}>Out with</h2>
              <ul className="mt-2 divide-y divide-slate-800 text-sm">
                {d.holders.map((h) => (
                  <li key={h.holderId} className="flex items-center justify-between py-1.5">
                    <Link to={`/supplies/holders/${h.holderId}`} className="text-slate-200 hover:underline">
                      {h.holderName}
                    </Link>
                    <span className="text-slate-100">
                      {fmtQty(h.balance)} {d.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <form onSubmit={save} className={`${CARD} space-y-3`}>
          <h2 className={H2}>How it is counted</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Unit" hint="each, box, roll, ft…">
              <input value={unit} onChange={(e) => setUnit(e.target.value)} className={FIELD} />
            </Field>
            <Field label="Supplier">
              <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className={FIELD} />
            </Field>
            <Field label="Reorder point" hint={`Low at or below this, per ${terms.location.singular.toLowerCase()}`}>
              <input value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} inputMode="decimal" className={FIELD} />
            </Field>
            <Field label="Reorder quantity">
              <input value={reorderQty} onChange={(e) => setReorderQty(e.target.value)} inputMode="decimal" className={FIELD} />
            </Field>
          </div>
          <p className="text-xs text-slate-500">
            The cost per {d.unit} is the {terms.item.singular.toLowerCase()}'s value, set on its own page.
          </p>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} className={BUTTON}>
              Save
            </button>
            <button type="button" onClick={untrack} className={BUTTON_QUIET}>
              Stop tracking
            </button>
          </div>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </form>
      </div>

      <section className={CARD}>
        <h2 className={H2}>History</h2>
        <MovementList movements={d.movements} />
      </section>
    </div>
  );
}
