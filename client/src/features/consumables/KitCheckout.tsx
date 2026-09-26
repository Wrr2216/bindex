import { useCallback, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { BUTTON, FIELD, Field } from "../../components/ui";
import { suppliesApi } from "./api";
import { Badge, CARD, H2, HolderSelect, Notice, PageHeader, errText, useHolders, useScanTo } from "./shared";
import type { DescribedCode, KitDetail, KitFailure } from "./types";

type Scanned = DescribedCode & { pending?: boolean };

const keyOf = (s: Scanned) => (s.itemId ? `${s.itemId}|${s.unitId ?? ""}` : `code:${s.code}`);

/** Default due-back time: this evening, or tomorrow morning when it is already evening. */
function defaultDue(): string {
  const d = new Date();
  if (d.getHours() >= 17) {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  } else {
    d.setHours(18, 0, 0, 0);
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Check many pieces of equipment out to one holder in a single scan session.
 * Every read lands in the list while this screen is open; nothing is checked
 * out until the list is confirmed.
 */
export function KitCheckout() {
  const terms = useTerms();
  const [params] = useSearchParams();
  const { holders } = useHolders();
  const [holderId, setHolderId] = useState(params.get("holder") ?? "");
  const [due, setDue] = useState(defaultDue);
  const [jobRef, setJobRef] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Scanned[]>([]);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ kit: KitDetail; failures: KitFailure[] } | null>(null);
  const seen = useRef(new Set<string>());

  const add = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code || seen.current.has(code)) return;
    seen.current.add(code);
    setDone(null);
    setLines((cur) => [
      {
        code,
        kind: "unknown",
        itemId: null,
        unitId: null,
        locationId: null,
        name: null,
        assetCode: null,
        unitLabel: null,
        consumable: false,
        outTo: null,
        pending: true,
      },
      ...cur,
    ]);
    try {
      const [d] = await suppliesApi.resolve([code]);
      setLines((cur) => {
        const rest = cur.filter((l) => l.code !== code);
        // The same piece read twice (its label and its RFID tag) is one line.
        if (d && d.itemId && rest.some((l) => keyOf(l) === keyOf(d))) return rest;
        return d ? [d, ...rest] : rest;
      });
    } catch (e) {
      seen.current.delete(code);
      setLines((cur) => cur.filter((l) => l.code !== code));
      setErr(errText(e));
    }
  }, []);

  useScanTo((code) => void add(code), "bulk");

  const remove = (code: string) => {
    seen.current.delete(code);
    setLines((cur) => cur.filter((l) => l.code !== code));
  };

  const ready = lines.filter((l) => l.kind === "item" && !l.consumable && !l.pending);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!holderId) return setErr(`Pick who the equipment is going to.`);
    if (!ready.length) return setErr("Scan at least one piece of equipment.");
    setBusy(true);
    setErr(null);
    try {
      const res = await suppliesApi.createKit({
        holderId,
        expectedReturnAt: due ? new Date(due).toISOString() : null,
        jobRef: jobRef.trim() || null,
        note: note.trim() || null,
        lines: ready.map((l) => ({ itemId: l.itemId!, unitId: l.unitId })),
      });
      setDone(res);
      setLines([]);
      seen.current.clear();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Check out a kit" back="/supplies" />

      <form onSubmit={submit} className={`${CARD} space-y-3`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <HolderSelect label={`Going to (${terms.holder.singular.toLowerCase()})`} value={holderId} onChange={setHolderId} holders={holders} />
          <Field label="Due back">
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={FIELD} />
          </Field>
          <Field label="Job or reference">
            <input value={jobRef} onChange={(e) => setJobRef(e.target.value)} className={FIELD} placeholder="Optional" />
          </Field>
          <Field label="Note">
            <input value={note} onChange={(e) => setNote(e.target.value)} className={FIELD} placeholder="Optional" />
          </Field>
        </div>
        <button disabled={busy || !ready.length} className={`${BUTTON} w-full sm:w-auto`}>
          {busy ? "Checking out…" : `Check out ${ready.length} piece${ready.length === 1 ? "" : "s"}`}
        </button>
      </form>

      <section className={CARD}>
        <div className="flex items-center justify-between">
          <h2 className={H2}>Scanned</h2>
          <span className="text-sm text-slate-400">{lines.length} read</span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Scan each piece with your reader, the camera or an RFID reader. Codes can also be typed.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add(manual);
                setManual("");
              }
            }}
            placeholder="Add a code by hand"
            aria-label="Add a code by hand"
            className={`${FIELD} flex-1`}
          />
        </div>
        {lines.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-800">
            {lines.map((l) => (
              <li key={l.code} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate text-slate-100">
                    {l.pending ? "Looking up…" : (l.name ?? l.code)}
                    {l.unitLabel && <span className="ml-2 text-slate-400">{l.unitLabel}</span>}
                  </p>
                  <p className="truncate text-xs text-slate-500">{l.assetCode ?? l.code}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!l.pending && l.kind === "unknown" && <Badge tone="late">No match</Badge>}
                  {l.kind === "location" && <Badge tone="muted">A {terms.location.singular.toLowerCase()}, skipped</Badge>}
                  {l.consumable && <Badge tone="late">Supply: issue it instead</Badge>}
                  {l.kind === "item" && !l.consumable && l.outTo && (
                    <Badge tone="low">Out to {l.outTo.holderName}; will be handed over</Badge>
                  )}
                  <button type="button" onClick={() => remove(l.code)} className="text-xs text-slate-500 hover:text-red-400">
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {err && <Notice tone="error">{err}</Notice>}
      {done && (
        <Notice tone={done.failures.length ? "warn" : "ok"}>
          Checked out {done.kit.total} piece{done.kit.total === 1 ? "" : "s"} to {done.kit.holderName}.{" "}
          <Link to={`/supplies/kits/${done.kit.id}`} className="underline">
            Open the kit
          </Link>
          {done.failures.length > 0 && (
            <span className="block">
              Not checked out: {done.failures.map((f) => `${f.name ?? f.itemId} (${f.error})`).join("; ")}
            </span>
          )}
        </Notice>
      )}
    </div>
  );
}
