import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { BUTTON, FIELD } from "../../components/ui";
import { suppliesApi } from "./api";
import {
  Badge,
  CARD,
  H2,
  HOLDER_KINDS,
  LowStockCard,
  Notice,
  PageHeader,
  SMALL_BUTTON,
  errText,
  fmtQty,
  kindLabel,
} from "./shared";
import type { CatalogRow, HolderSummary, KitSummary } from "./types";

const ACTIONS: { to: string; label: string; hint: string }[] = [
  { to: "/supplies/move/receive", label: "Receive", hint: "Stock arriving" },
  { to: "/supplies/move/issue", label: "Issue", hint: "To a crew or truck" },
  { to: "/supplies/move/return", label: "Return", hint: "Unused, coming back" },
  { to: "/supplies/move/consume", label: "Record use", hint: "Used up" },
  { to: "/supplies/count", label: "Count", hint: "Cycle count a shelf" },
  { to: "/supplies/move/transfer", label: "Transfer", hint: "Between places" },
];

/** The Supplies landing screen: quick actions first, since it is mostly used on a phone. */
export function SuppliesHome() {
  const terms = useTerms();
  const { user } = useAuth();
  const [catalog, setCatalog] = useState<CatalogRow[] | null>(null);
  const [q, setQ] = useState("");
  const [holders, setHolders] = useState<HolderSummary[]>([]);
  const [kits, setKits] = useState<KitSummary[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("crew");
  const [err, setErr] = useState<string | null>(null);

  const loadHolders = () => suppliesApi.holders().then(setHolders).catch(() => undefined);
  useEffect(() => {
    void loadHolders();
    suppliesApi.kits("open").then(setKits).catch(() => undefined);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      suppliesApi.catalog(q.trim() || undefined).then(setCatalog).catch(() => setCatalog([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const addHolder = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setErr(null);
    try {
      await api.createEntity({ name: name.trim(), kind });
      setName("");
      await loadHolders();
    } catch (e2) {
      setErr(errText(e2));
    }
  };

  const overdueKits = kits.filter((k) => k.overdue);

  return (
    <div className="space-y-6">
      <PageHeader title="Supplies">
        <Link to="/supplies/add" className={SMALL_BUTTON}>
          Add a supply
        </Link>
        <Link to="/supplies/reports" className={SMALL_BUTTON}>
          Reports
        </Link>
      </PageHeader>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {ACTIONS.map((a) => (
          <Link
            key={a.to}
            to={a.to}
            className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 hover:border-sky-700 hover:bg-slate-800"
          >
            <span className="block font-medium text-slate-100">{a.label}</span>
            <span className="block text-xs text-slate-500">{a.hint}</span>
          </Link>
        ))}
        {user?.role === "admin" && (
          <Link
            to="/supplies/move/adjust"
            className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 hover:border-sky-700 hover:bg-slate-800"
          >
            <span className="block font-medium text-slate-100">Adjust</span>
            <span className="block text-xs text-slate-500">Administrators, with a reason</span>
          </Link>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <LowStockCard />

        <section className={CARD}>
          <div className="flex items-center justify-between">
            <h2 className={H2}>Equipment out</h2>
            <Link to="/supplies/kits/new" className="text-sm text-sky-400 hover:underline">
              Check out a kit
            </Link>
          </div>
          {kits.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No kits are out.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-800">
              {kits.slice(0, 6).map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <Link to={`/supplies/kits/${k.id}`} className="truncate text-slate-200 hover:underline">
                    {k.holderName}
                    {k.jobRef && <span className="ml-2 text-slate-500">{k.jobRef}</span>}
                  </Link>
                  <span className="flex shrink-0 items-center gap-2 text-slate-400">
                    {k.outCount} of {k.total} out
                    {k.overdue && <Badge tone="late">Overdue</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {overdueKits.length > 0 && (
            <p className="mt-2 text-xs text-red-300">
              {overdueKits.length} kit{overdueKits.length === 1 ? "" : "s"} past the expected return.
            </p>
          )}
        </section>
      </div>

      <section className={CARD}>
        <h2 className={H2}>Crews, trucks and branches</h2>
        <p className="mt-1 text-sm text-slate-500">
          Open one for its end-of-day return: what went out, what came back and what is still out.
        </p>
        {holders.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">None yet. Add one below.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-800">
            {holders.map((h) => (
              <li key={h.id}>
                <Link
                  to={`/supplies/holders/${h.id}`}
                  className="flex items-center justify-between gap-3 py-2 text-sm hover:bg-slate-800/40"
                >
                  <span className="truncate text-slate-100">
                    {h.name}
                    {h.kind && <span className="ml-2 text-slate-500">{kindLabel(h.kind)}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-slate-400">
                    {h.suppliesOut > 0 && <span>{h.suppliesOut} supplies</span>}
                    {h.equipmentOut > 0 && <span>{h.equipmentOut} equipment</span>}
                    {h.overdue > 0 && <Badge tone="late">{h.overdue} overdue</Badge>}
                    {h.suppliesOut + h.equipmentOut === 0 && <span className="text-slate-600">Nothing out</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addHolder} className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Crew 3, Truck 12, North branch…"
            aria-label={`New ${terms.holder.singular.toLowerCase()} name`}
            className={`${FIELD} flex-1`}
          />
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${FIELD} sm:w-36`} aria-label="Kind">
            {HOLDER_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <button className={BUTTON}>Add</button>
        </form>
        {err && <div className="mt-2"><Notice tone="error">{err}</Notice></div>}
      </section>

      <section className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={H2}>Stock</h2>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search supplies"
            aria-label="Search supplies"
            className={`${FIELD} sm:w-64`}
          />
        </div>
        {catalog === null ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : catalog.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            {q ? "No supplies match." : (
              <>
                No supplies yet.{" "}
                <Link to="/supplies/add" className="text-sky-400 hover:underline">
                  Add boxes, tape or pads
                </Link>{" "}
                to start counting them.
              </>
            )}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-800">
            {catalog.map((c) => (
              <li key={c.itemId}>
                <Link to={`/supplies/items/${c.itemId}`} className="block py-2 hover:bg-slate-800/40">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium text-slate-100">{c.name}</span>
                    <span className="flex shrink-0 items-center gap-2 text-sm">
                      {c.low && <Badge tone="low">Low</Badge>}
                      <span className="text-slate-200">
                        {fmtQty(c.onHand)} {c.unit}
                      </span>
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {c.levels.length
                      ? c.levels.map((l) => `${l.locationName} ${fmtQty(l.qty)}`).join(" · ")
                      : `Not in any ${terms.location.singular.toLowerCase()} yet`}
                    {c.outstanding !== 0 && ` · ${fmtQty(c.outstanding)} out with crews`}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
