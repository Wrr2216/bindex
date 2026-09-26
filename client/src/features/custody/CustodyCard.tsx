import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { custodyApi } from "./api";
import type { ChainEntry, ItemChain } from "./types";
import { BTN_QUIET, H2, OutcomeBadge, StatusBadge, errorText, when } from "./ui";

const partyText = (p: { name: string; org: string | null }) => (p.org ? `${p.name} (${p.org})` : p.name);

function Hop({ hop, index }: { hop: ChainEntry; index: number }) {
  return (
    <li className="relative border-l-2 border-slate-700 pb-4 pl-4 last:pb-0">
      <span className="absolute -left-[9px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-[10px] font-bold text-slate-200">
        {index}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/custody/transfers/${hop.transferId}`} className="font-mono text-sm text-sky-300 hover:underline">
          {hop.code}
        </Link>
        <span className="text-xs uppercase tracking-wide text-slate-400">{hop.purposeLabel}</span>
        {hop.status !== "completed" && <StatusBadge status={hop.status} />}
        {hop.outcome !== "accepted" && <OutcomeBadge outcome={hop.outcome} />}
      </div>
      <p className="text-sm text-slate-200">
        {partyText(hop.from)} <span className="text-slate-500">→</span> {partyText(hop.to)}
      </p>
      <p className="text-xs text-slate-400">
        {[
          hop.at ? when(hop.at) : `Started ${when(hop.createdAt)}`,
          hop.place,
          hop.jobCode,
          hop.shipmentCode,
          hop.seals.length ? `Seals ${hop.seals.join(", ")}` : null,
          hop.inside ? `Inside ${hop.inside}` : null,
          hop.unitCode ? `Unit ${hop.unitCode}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {hop.note && <p className="text-xs text-red-300">{hop.note}</p>}
      {hop.signatures.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {hop.signatures.map((s) => (
            <figure key={s.id} className="rounded-md bg-white px-2 py-1" title={`Signed ${when(s.signedAt)}${s.via === "link" ? " by link" : ""}`}>
              {s.imageUrl && <img src={s.imageUrl} alt={`Signature of ${s.signerName}`} className="h-8 max-w-[140px] object-contain" />}
              <figcaption className="text-[10px] text-slate-700">{s.signerName}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * The chain of custody on an item's page: whether it is controlled, who holds
 * it now, and every signed handoff it has been through.
 */
export function CustodyCard({ itemId }: { itemId: string }) {
  const terms = useTerms();
  const { user } = useAuth();
  const [chain, setChain] = useState<ItemChain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    custodyApi
      .chain(itemId)
      .then(setChain)
      .catch((err) => setError(errorText(err, "The chain of custody could not be loaded.")));
  }, [itemId]);
  useEffect(load, [load]);

  const toggle = async () => {
    if (!chain) return;
    const next = !chain.control;
    let reason: string | null = null;
    if (next) {
      reason = window.prompt("Why is this custody-controlled? (optional, e.g. personnel records)") ?? null;
    } else if (!window.confirm("Stop requiring a signed handoff for this? Its history stays.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await custodyApi.setControl(itemId, next, reason);
      load();
    } catch (err) {
      setError(errorText(err, "That could not be changed."));
    } finally {
      setBusy(false);
    }
  };

  if (!chain) {
    return error ? <p className="text-sm text-red-300">{error}</p> : null;
  }

  return (
    <section aria-label="Chain of custody" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={H2}>Chain of custody</h2>
        <div className="flex gap-2">
          {(!chain.control || user?.role === "admin") && (
            <button onClick={() => void toggle()} disabled={busy} className={BTN_QUIET}>
              {chain.control ? "Release control" : "Require signed handoffs"}
            </button>
          )}
          <Link to={`/custody/new?item=${encodeURIComponent(chain.item.assetCode)}`} className={BTN_QUIET}>
            Hand off
          </Link>
        </div>
      </div>

      {chain.controlled && (
        <p className="rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          Custody-controlled
          {chain.controlledBy ? ` because it is packed in ${chain.controlledBy}` : chain.control?.reason ? `: ${chain.control.reason}` : ""}. It
          cannot be marked delivered on a job until a delivery is signed for. Record every handoff here.
        </p>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}

      <div className="rounded-lg bg-slate-800/60 px-3 py-2 text-sm">
        <span className="text-slate-400">Current custodian: </span>
        {chain.custodian ? (
          <>
            <span className="font-medium text-slate-100">{partyText(chain.custodian)}</span>
            <span className="text-slate-400"> since {when(chain.custodian.since)}</span>
          </>
        ) : (
          <span className="text-slate-400">No signed handoff of this {terms.item.singular.toLowerCase()} yet.</span>
        )}
      </div>

      {chain.hops.length > 0 && (
        <ol className="ml-2 space-y-0">
          {chain.hops.map((hop, i) => (
            <Hop key={hop.transferId} hop={hop} index={i + 1} />
          ))}
        </ol>
      )}
      {chain.pending.length > 0 && (
        <div>
          <p className="mb-1 text-xs uppercase tracking-wide text-slate-500">In progress</p>
          <ol className="ml-2">
            {chain.pending.map((hop, i) => (
              <Hop key={hop.transferId} hop={hop} index={chain.hops.length + i + 1} />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
