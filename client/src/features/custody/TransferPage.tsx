import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import { custodyApi, type OutcomeInput } from "./api";
import type { Outcome, Party, ScanOutcome, TransferDetail, TransferLine } from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  OUTCOME_TEXT,
  OutcomeBadge,
  SELECT,
  SignPartyDialog,
  StatusBadge,
  VerifyPanel,
  errorText,
  partyLabel,
  when,
} from "./ui";

const FLUSH_MS = 150;

type FeedEntry = { id: number; tone: "ok" | "already" | "bad"; text: string };

/** Scan items onto a draft: a handheld, the camera and the live reader feed all arrive here. */
function ScanPanel({ transferId, onChanged }: { transferId: string; onChanged: () => void }) {
  const terms = useTerms();
  const { armBulkCapture, rfidEnabled, setRfidEnabled, rfidReaderId } = useScan();
  const [active, setActive] = useState(false);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const queue = useRef<string[]>([]);
  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);

  const record = useCallback(
    (r: ScanOutcome) => {
      const entries: FeedEntry[] = [];
      const add = (tone: FeedEntry["tone"], text: string) => entries.push({ id: ++seq.current, tone, text });
      for (const a of r.added)
        add("ok", `Added ${a.name} (${a.assetCode})${a.contents ? `, with ${a.contents} packed inside` : ""}`);
      for (const a of r.already) add("already", `Already listed: ${a.name} (${a.assetCode})`);
      for (const c of r.unknown) add("bad", `Unknown code ${c}: no ${terms.item.singular.toLowerCase()} has it`);
      for (const a of r.ambiguous) add("bad", `${a.code} is shared by ${a.count} ${terms.item.plural.toLowerCase()}; scan its own label`);
      setFeed((f) => [...entries.reverse(), ...f].slice(0, 60));
      if (r.added.length) onChanged();
    },
    [onChanged, terms.item.plural, terms.item.singular],
  );

  const send = useCallback(
    async (codes: string[], via: "scan" | "manual") => {
      setError(null);
      try {
        record(await custodyApi.scan(transferId, codes, via));
      } catch (err) {
        setError(errorText(err, "The scans could not be saved."));
      }
    },
    [record, transferId],
  );

  const flush = useCallback(async () => {
    timer.current = null;
    if (inFlight.current || !queue.current.length) return;
    const codes = queue.current.splice(0, queue.current.length);
    inFlight.current = true;
    try {
      await send(codes, "scan");
    } finally {
      inFlight.current = false;
      if (queue.current.length) timer.current = window.setTimeout(() => void flush(), 0);
    }
  }, [send]);

  const enqueue = useCallback(
    (code: string) => {
      queue.current.push(code);
      if (timer.current === null) timer.current = window.setTimeout(() => void flush(), FLUSH_MS);
    },
    [flush],
  );

  useEffect(() => {
    armBulkCapture(active ? enqueue : null);
  }, [active, enqueue, armBulkCapture]);
  useEffect(() => () => armBulkCapture(null), [armBulkCapture]);

  const start = async () => {
    // The reader feed reports each tag once per channel; clear it so boxes read earlier count here.
    if (rfidEnabled) await api.auditLiveClear(rfidReaderId).catch(() => undefined);
    setActive(true);
  };

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    const codes = manual.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean);
    if (!codes.length) return;
    setManual("");
    void send(codes, "manual");
  };

  return (
    <section className={`${CARD} space-y-3`} aria-label="Scan items">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={H2}>Scan what is being handed over</h2>
        {!active ? (
          <button onClick={() => void start()} className={BTN}>
            Start scanning
          </button>
        ) : (
          <button onClick={() => setActive(false)} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500">
            Stop
          </button>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={rfidEnabled} onChange={(e) => setRfidEnabled(e.target.checked)} disabled={active} />
        Use the live reader feed
      </label>
      {active && (
        <p className="animate-pulse text-sm text-sky-300">
          Scanning. Scan a container once; what is packed inside it comes with it.
        </p>
      )}
      <form onSubmit={submitManual} className="flex gap-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Or type codes (separated by spaces)"
          aria-label="Codes to add"
          className={FIELD}
        />
        <button className="rounded-lg bg-slate-700 px-4 text-sm text-slate-100 hover:bg-slate-600">Add</button>
      </form>
      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}
      {feed.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto text-sm" aria-live="polite">
          {feed.map((f) => (
            <li
              key={f.id}
              className={`rounded-lg px-3 py-1 ${f.tone === "ok" ? "bg-emerald-950/60 text-emerald-200" : f.tone === "already" ? "bg-slate-800 text-slate-300" : "bg-red-950/60 text-red-200"}`}
            >
              {f.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConfirmCount({ transfer, onLocked }: { transfer: TransferDetail; onLocked: (t: TransferDetail) => void }) {
  const [count, setCount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const contained = transfer.lines.length - transfer.counted;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(count);
    if (!Number.isInteger(n) || n < 0) return;
    setBusy(true);
    setError(null);
    try {
      onLocked(await custodyApi.lock(transfer.id, n));
    } catch (err) {
      setError(errorText(err, "The count could not be confirmed."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`${CARD} space-y-2`} aria-label="Confirm the count">
      <h2 className={H2}>Confirm the count</h2>
      <p className="text-sm text-slate-300">
        {transfer.counted} scanned{contained ? `, with ${contained} more packed inside them` : ""}. Count what is physically being handed over
        and enter the number. It must match before anyone signs; after that the list cannot change.
      </p>
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          aria-label="Counted"
          placeholder="Counted"
          className={`${FIELD} w-32`}
        />
        <button disabled={busy || count === "" || transfer.lines.length === 0} className={BTN}>
          {busy ? "Checking…" : "Confirm and fix the list"}
        </button>
      </form>
      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}
    </section>
  );
}

function Lines({
  transfer,
  editable,
  outcomes,
  onOutcome,
  onRemove,
}: {
  transfer: TransferDetail;
  editable: "none" | "remove" | "outcome";
  outcomes: Record<string, { outcome: Outcome; note: string }>;
  onOutcome: (lineId: string, value: { outcome: Outcome; note: string }) => void;
  onRemove: (line: TransferLine) => void;
}) {
  const codeOf = useMemo(() => new Map(transfer.lines.map((l) => [l.itemId, l.assetCode])), [transfer.lines]);
  return (
    <section className={`${CARD} space-y-2`} aria-label="Items">
      <h2 className={H2}>
        Items ({transfer.counted}
        {transfer.lines.length > transfer.counted ? ` + ${transfer.lines.length - transfer.counted} inside` : ""})
      </h2>
      {transfer.lines.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing yet. Scan the first label.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {transfer.lines.map((l) => {
            const o = outcomes[l.id] ?? { outcome: l.outcome, note: l.note ?? "" };
            return (
              <li key={l.id} className={`flex flex-wrap items-start gap-2 py-2 ${l.via === "contained" ? "pl-5" : ""}`}>
                <div className="min-w-0 flex-1">
                  <Link to={`/items/${l.itemId}`} className="text-sm text-slate-100 hover:underline">
                    {l.name}
                  </Link>
                  <p className="font-mono text-xs text-slate-400">
                    {l.unitCode ?? l.assetCode}
                    {l.via === "contained" && l.parentItemId ? ` · inside ${codeOf.get(l.parentItemId) ?? "a container"}` : ""}
                  </p>
                  {editable !== "outcome" && l.note && <p className="text-xs text-red-300">{l.note}</p>}
                </div>
                {editable === "outcome" ? (
                  <div className="flex w-full flex-col gap-1 sm:w-56">
                    <select
                      value={o.outcome}
                      onChange={(e) => onOutcome(l.id, { ...o, outcome: e.target.value as Outcome })}
                      aria-label={`What was found for ${l.name}`}
                      className={`${SELECT} ${o.outcome === "accepted" ? "" : "border-red-800 text-red-200"}`}
                    >
                      {(Object.keys(OUTCOME_TEXT) as Outcome[]).map((k) => (
                        <option key={k} value={k}>
                          {OUTCOME_TEXT[k]}
                        </option>
                      ))}
                    </select>
                    {o.outcome !== "accepted" && (
                      <input
                        value={o.note}
                        onChange={(e) => onOutcome(l.id, { ...o, note: e.target.value })}
                        placeholder="What was wrong"
                        maxLength={500}
                        aria-label={`Note for ${l.name}`}
                        className={FIELD}
                      />
                    )}
                  </div>
                ) : (
                  <>
                    {l.outcome !== "accepted" && <OutcomeBadge outcome={l.outcome} />}
                    {editable === "remove" && l.via !== "contained" && (
                      <button onClick={() => onRemove(l)} className="text-xs text-slate-400 hover:text-red-300" aria-label={`Remove ${l.name}`}>
                        Remove
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function LinkBox({ url, expiresAt, onDone }: { url: string; expiresAt: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const share = typeof navigator !== "undefined" && "share" in navigator;
  return (
    <div className="space-y-2 rounded-lg border border-sky-900 bg-sky-950/40 p-3 text-sm">
      <p className="text-sky-100">Send this link to the party. It works once, until {when(expiresAt)}, and is not shown again.</p>
      <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Signing link" className={`${FIELD} font-mono text-xs`} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN_QUIET}
          onClick={() =>
            void navigator.clipboard?.writeText(url).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        {share && (
          <button type="button" className={BTN_QUIET} onClick={() => void navigator.share({ title: "Sign for a custody transfer", url }).catch(() => undefined)}>
            Share
          </button>
        )}
        <button type="button" className={BTN_QUIET} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

export function Signatures({
  transfer,
  outcomes,
  onChanged,
  beforeLink,
}: {
  transfer: TransferDetail;
  outcomes?: OutcomeInput[];
  onChanged: (t: TransferDetail) => void;
  beforeLink?: () => Promise<void>;
}) {
  const [signing, setSigning] = useState<Party | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = transfer.status === "draft" || transfer.status === "locked";

  const sendLink = async (party: Party) => {
    setBusy(true);
    setError(null);
    try {
      await beforeLink?.();
      const r = await custodyApi.issueLink(transfer.id, party);
      setLink({ url: r.url, expiresAt: r.expiresAt });
      onChanged(r.transfer);
    } catch (err) {
      setError(errorText(err, "The link could not be made."));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    setBusy(true);
    try {
      await custodyApi.revokeLink(transfer.id);
      setLink(null);
      onChanged(await custodyApi.get(transfer.id));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${CARD} space-y-3`} aria-label="Signatures">
      <h2 className={H2}>Signatures</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["from", "to"] as Party[]).map((party) => {
          const sigId = party === "from" ? transfer.fromSignatureId : transfer.toSignatureId;
          const sig = transfer.signatures.find((s) => s.id === sigId);
          const required = transfer.required.includes(party);
          const name = party === "from" ? transfer.fromName : transfer.toName;
          const linkHere = transfer.link.state === "active" && transfer.link.party === party;
          return (
            <div key={party} className="space-y-2 rounded-lg border border-slate-800 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                {partyLabel(party)}
                {!required && " (optional)"}
              </p>
              <p className="text-sm font-medium text-slate-100">{name}</p>
              {sig ? (
                <div className="space-y-1">
                  {sig.imageUrl && (
                    <div className="rounded-md bg-white p-2">
                      <img src={sig.imageUrl} alt={`Signature of ${sig.signerName}`} className="mx-auto h-16 object-contain" />
                    </div>
                  )}
                  <p className="text-xs text-slate-300">
                    {sig.signerName}
                    {sig.signerRole ? `, ${sig.signerRole}` : ""} · {when(sig.signedAt)}
                    {transfer.signing[party]?.via === "link" ? " · on their own device" : ""}
                  </p>
                </div>
              ) : open ? (
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setSigning(party)} disabled={transfer.status === "draft" && transfer.purpose !== "delivery"} className={BTN}>
                    Sign on this device
                  </button>
                  {(transfer.status === "locked" || (transfer.purpose === "delivery" && party === "to")) && (
                    <button onClick={() => void sendLink(party)} disabled={busy} className={BTN_QUIET}>
                      {linkHere ? "New link" : "Send a link"}
                    </button>
                  )}
                  {linkHere && (
                    <p className="w-full text-xs text-sky-300">
                      Link sent; it expires {when(transfer.link.expiresAt)}.{" "}
                      <button onClick={() => void revoke()} className="underline">
                        Cancel it
                      </button>
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-500">Not signed.</p>
              )}
            </div>
          );
        })}
      </div>
      {link && <LinkBox url={link.url} expiresAt={link.expiresAt} onDone={() => setLink(null)} />}
      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}
      {signing && (
        <SignPartyDialog
          transfer={transfer}
          party={signing}
          outcomes={transfer.status === "draft" ? outcomes : undefined}
          onClose={() => setSigning(null)}
          onSigned={(r) => {
            setSigning(null);
            if (r.finalized?.error) setError(r.finalized.error);
            onChanged(r.transfer);
          }}
        />
      )}
    </section>
  );
}

function Effects({ transfer }: { transfer: TransferDetail }) {
  const effects = transfer.metadata.effects as
    | { stages?: Record<string, { changed: number } | string | null>; checkedOut?: number; checkedIn?: number; moved?: number; errors?: string[] }
    | undefined;
  if (!effects) return null;
  const parts: string[] = [];
  for (const [stage, r] of Object.entries(effects.stages ?? {})) {
    if (stage === "shipment") {
      if (r) parts.push(`${transfer.shipmentCode ?? "The shipment"} marked delivered`);
    } else if (r && typeof r === "object" && r.changed) parts.push(`${r.changed} line${r.changed === 1 ? "" : "s"} marked ${stage}`);
  }
  if (effects.checkedOut) parts.push(`${effects.checkedOut} checked out to ${transfer.toName}`);
  if (effects.checkedIn) parts.push(`${effects.checkedIn} checked back in`);
  if (effects.moved) parts.push(`${effects.moved} moved to ${transfer.locationName ?? "the place"}`);
  if (!parts.length && !effects.errors?.length) return null;
  return (
    <div className="rounded-lg bg-slate-800/60 px-3 py-2 text-sm text-slate-300">
      {parts.length > 0 && <p>{parts.join(" · ")}.</p>}
      {effects.errors?.map((e) => (
        <p key={e} className="text-amber-300">
          {e}
        </p>
      ))}
    </div>
  );
}

export function TransferPage() {
  const { id = "" } = useParams();
  const [t, setT] = useState<TransferDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, { outcome: Outcome; note: string }>>({});
  const [verifyKey, setVerifyKey] = useState(0);

  const load = useCallback(() => {
    custodyApi
      .get(id)
      .then(setT)
      .catch((err) => setError(errorText(err, "This transfer could not be loaded.")));
  }, [id]);
  useEffect(load, [load]);

  const outcomeList = useMemo<OutcomeInput[]>(
    () => Object.entries(outcomes).map(([lineId, o]) => ({ lineId, outcome: o.outcome, note: o.note.trim() || null })),
    [outcomes],
  );

  if (!t) return error ? <p className="text-red-300">{error}</p> : <p className="text-slate-400">Loading…</p>;

  const delivery = t.purpose === "delivery";
  const saveOutcomes = async () => {
    if (outcomeList.length) await custodyApi.setOutcomes(t.id, outcomeList);
  };
  const doVoid = async () => {
    const reason = window.prompt("Why is this transfer being abandoned?");
    if (reason === null) return;
    try {
      setT(await custodyApi.void(t.id, reason));
    } catch (err) {
      setError(errorText(err, "It could not be voided."));
    }
  };
  const finish = async () => {
    try {
      setT((await custodyApi.finalize(t.id)).transfer);
      setVerifyKey((k) => k + 1);
    } catch (err) {
      setError(errorText(err, "It could not be finished."));
    }
  };
  const remove = async (line: TransferLine) => {
    try {
      await custodyApi.removeLines(t.id, [line.id]);
      load();
    } catch (err) {
      setError(errorText(err, "That line could not be removed."));
    }
  };

  const facts: [string, string][] = [];
  if (t.at) facts.push(["Handed over", when(t.at)]);
  if (t.locationName) facts.push(["Place", t.locationName]);
  if (t.lat !== null && t.lng !== null) facts.push(["Position", `${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}${t.accuracyM ? ` (±${t.accuracyM} m)` : ""}`]);
  if (t.jobCode) facts.push(["Job", t.jobCode]);
  if (t.shipmentCode) facts.push(["Shipment", t.shipmentCode]);
  facts.push(["Seals", t.sealNumbers.length ? t.sealNumbers.join(", ") : "None recorded"]);
  if (t.conditionNote) facts.push(["Condition", t.conditionNote]);
  if (t.voidReason) facts.push(["Voided", t.voidReason]);

  return (
    <div className="space-y-4">
      <Link to="/custody" className="text-sm text-sky-300 hover:underline">
        ← Chain of custody
      </Link>
      <section className={`${CARD} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">{t.purposeLabel}</p>
            <h1 className="text-2xl font-semibold text-slate-100">
              {t.fromName} → {t.toName}
            </h1>
            <p className="font-mono text-sm text-slate-400">{t.code}</p>
          </div>
          <StatusBadge status={t.status} />
        </div>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-slate-400">{k}</dt>
              <dd className="text-slate-200">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          <a href={custodyApi.receiptUrl(t.id)} target="_blank" rel="noreferrer" className={BTN_QUIET}>
            {t.status === "completed" ? "Receipt (PDF)" : "Preview receipt"}
          </a>
          {(t.status === "draft" || t.status === "locked") && (
            <button onClick={() => void doVoid()} className={BTN_DANGER}>
              Void
            </button>
          )}
          {t.status === "completed" && (!t.receiptAttachmentId || !t.auditEntryId) && (
            <button onClick={() => void finish()} className={BTN}>
              Finish receipt
            </button>
          )}
        </div>
        {t.status === "completed" && <Effects transfer={t} />}
      </section>

      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}

      {t.status === "draft" && !delivery && <ScanPanel transferId={t.id} onChanged={load} />}
      {t.status === "draft" && delivery && (
        <p className="rounded-lg border border-slate-800 px-3 py-2 text-sm text-slate-300">
          The receiving party checks every line, marks anything missing, damaged or refused, and signs. Hand them this device, or send them a
          link.
        </p>
      )}

      <Lines
        transfer={t}
        editable={t.status !== "draft" ? "none" : delivery ? "outcome" : "remove"}
        outcomes={outcomes}
        onOutcome={(lineId, v) => setOutcomes((o) => ({ ...o, [lineId]: v }))}
        onRemove={(l) => void remove(l)}
      />

      {t.status === "draft" && !delivery && <ConfirmCount transfer={t} onLocked={setT} />}

      {t.status !== "void" && (t.status !== "draft" || delivery) && (
        <Signatures
          transfer={t}
          outcomes={outcomeList}
          beforeLink={delivery && t.status === "draft" ? saveOutcomes : undefined}
          onChanged={(next) => {
            setT(next);
            setVerifyKey((k) => k + 1);
          }}
        />
      )}

      {t.status === "completed" && <VerifyPanel transferId={t.id} refreshKey={verifyKey} />}
    </div>
  );
}
