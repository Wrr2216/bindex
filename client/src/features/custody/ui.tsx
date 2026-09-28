import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useFeatures, useTerms } from "../../config/useConfig";
import type { Entity } from "../../types";
import { Modal, SignaturePad } from "../media-ai-core";
import { custodyApi, type OutcomeInput } from "./api";
import type { CustodyMeta, CustodyStatus, Outcome, Party, PartyInput, SignResponse, TransferDetail, VerifyReport } from "./types";

/** Small pieces shared by the custody screens. */

export const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
export const SELECT =
  "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none";
export const BTN = "rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
export const BTN_QUIET =
  "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
export const BTN_DANGER =
  "rounded-lg border border-red-900 px-3 py-2 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-50";
export const CARD = "rounded-xl border border-slate-800 bg-slate-900 p-4";
export const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";
export const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";

export const errorText = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof Error && err.message ? err.message : fallback;

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

export const partyLabel = (party: Party) => (party === "from" ? "Releasing party" : "Receiving party");

let metaPromise: Promise<CustodyMeta> | null = null;

export function useCustodyMeta(): CustodyMeta | null {
  const [meta, setMeta] = useState<CustodyMeta | null>(null);
  useEffect(() => {
    metaPromise ??= custodyApi.meta().catch((err) => {
      metaPromise = null;
      throw err;
    });
    let live = true;
    metaPromise.then((m) => live && setMeta(m)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return meta;
}

const STATUS_TONE: Record<CustodyStatus, string> = {
  draft: "bg-slate-800 text-slate-300",
  locked: "bg-amber-950 text-amber-300",
  completed: "bg-emerald-950 text-emerald-300",
  void: "bg-red-950 text-red-300",
};
const STATUS_TEXT: Record<CustodyStatus, string> = {
  draft: "Scanning",
  locked: "Awaiting signatures",
  completed: "Signed",
  void: "Void",
};

/** A delivery is not scanned: while open, its receiver is reviewing it. */
export function StatusBadge({ status, purpose }: { status: CustodyStatus; purpose?: string }) {
  const text = status === "draft" && purpose === "delivery" ? "Under review" : STATUS_TEXT[status];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>{text}</span>;
}

export const OUTCOME_TEXT: Record<Outcome, string> = {
  accepted: "Received",
  damaged: "Damaged",
  missing: "Missing",
  refused: "Refused",
};

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const tone = outcome === "accepted" ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{OUTCOME_TEXT[outcome]}</span>;
}

/** Who a party is: me, a holder, or someone named by hand. */
export function PartyFields({
  label,
  value,
  onChange,
  allowMe = true,
}: {
  label: string;
  value: PartyInput;
  onChange: (p: PartyInput) => void;
  allowMe?: boolean;
}) {
  const terms = useTerms();
  const features = useFeatures();
  const { user } = useAuth();
  const [entities, setEntities] = useState<Entity[]>([]);
  useEffect(() => {
    if (features.holders) api.listEntities().then(setEntities).catch(() => undefined);
  }, [features.holders]);

  const choice = value.kind === "user" ? "me" : value.kind;
  return (
    <fieldset className="space-y-2">
      <legend className={LABEL}>{label}</legend>
      <select
        value={choice}
        aria-label={`${label}: who`}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "me") onChange({ kind: "user", userOid: user?.oid ?? null });
          else if (v === "entity") onChange({ kind: "entity", entityId: entities[0]?.id ?? null });
          else onChange({ kind: "external", name: "", org: "" });
        }}
        className={`${SELECT} w-full`}
      >
        {allowMe && user && <option value="me">Me ({user.name})</option>}
        {features.holders && <option value="entity">A {terms.holder.singular.toLowerCase()}</option>}
        <option value="external">Someone else</option>
      </select>
      {value.kind === "entity" && (
        <select
          value={value.entityId ?? ""}
          onChange={(e) => onChange({ ...value, entityId: e.target.value || null })}
          aria-label={`${label}: ${terms.holder.singular}`}
          className={`${SELECT} w-full`}
        >
          <option value="">Pick a {terms.holder.singular.toLowerCase()}</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      )}
      {value.kind === "external" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={value.name ?? ""}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="Name"
            aria-label={`${label}: name`}
            maxLength={200}
            className={FIELD}
          />
          <input
            value={value.org ?? ""}
            onChange={(e) => onChange({ ...value, org: e.target.value })}
            placeholder="Organisation (optional)"
            aria-label={`${label}: organisation`}
            maxLength={200}
            className={FIELD}
          />
        </div>
      )}
    </fieldset>
  );
}

/**
 * One party signs on this device. The server builds what is signed from the
 * stored transfer, so the dialog only collects who is signing and the ink.
 */
export function SignPartyDialog({
  transfer,
  party,
  expectedCount,
  outcomes,
  onSigned,
  onClose,
}: {
  transfer: TransferDetail;
  party: Party;
  expectedCount?: number;
  outcomes?: OutcomeInput[];
  onSigned: (r: SignResponse) => void;
  onClose: () => void;
}) {
  const partyName = party === "from" ? transfer.fromName : transfer.toName;
  const kind = party === "from" ? transfer.fromKind : transfer.toKind;
  const [name, setName] = useState(kind === "entity" ? "" : partyName);
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [png, setPng] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statement = transfer.statements[party];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!png || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onSigned(
        await custodyApi.sign(transfer.id, {
          party,
          signerName: name.trim(),
          signerRole: role.trim() || null,
          signerEmail: email.trim() || null,
          image: png,
          expectedCount,
          outcomes,
        }),
      );
    } catch (err) {
      setError(errorText(err, "The signature could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${partyLabel(party)}: ${partyName}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <p className="whitespace-pre-line rounded-lg bg-slate-800/60 p-3 text-sm text-slate-200">{statement}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="custody-sign-name">
              Name *
            </label>
            <input id="custody-sign-name" className={FIELD} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required autoComplete="off" />
          </div>
          <div>
            <label className={LABEL} htmlFor="custody-sign-role">
              Role
            </label>
            <input
              id="custody-sign-role"
              className={FIELD}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              maxLength={120}
              placeholder={party === "from" ? "e.g. Records manager" : "e.g. Driver"}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="custody-sign-email">
              Email
            </label>
            <input id="custody-sign-email" type="email" className={FIELD} value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} />
          </div>
        </div>
        <SignaturePad onSigned={setPng} />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy || !png || !name.trim()} className={`${BTN} flex-1`}>
            {busy ? "Saving…" : "Agree and sign"}
          </button>
          <button type="button" onClick={onClose} className={BTN_QUIET}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  const tone = ok === null ? "text-slate-400" : ok ? "text-emerald-300" : "text-red-300";
  return (
    <li className="flex gap-2">
      <span aria-hidden className={`${tone} font-bold`}>
        {ok === null ? "–" : ok ? "✓" : "✗"}
      </span>
      <span className="text-slate-200">{children}</span>
    </li>
  );
}

const short = (h: string | null | undefined) => (h ? `${h.slice(0, 12)}…` : "none");

/** The receipt check: list, signatures, audit-log entry and stored PDF, each on its own line. */
export function VerifyPanel({ transferId, refreshKey = 0 }: { transferId: string; refreshKey?: number }) {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setError(null);
    custodyApi
      .verify(transferId)
      .then(setReport)
      .catch((err) => setError(errorText(err, "The receipt could not be checked.")))
      .finally(() => setBusy(false));
  };
  useEffect(run, [transferId, refreshKey]);

  return (
    <section className={`${CARD} space-y-3`} aria-label="Verification">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={H2}>Verification</h2>
        <button onClick={run} disabled={busy} className={BTN_QUIET}>
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      {report && (
        <>
          <div
            role="status"
            className={`rounded-lg px-4 py-3 ${report.valid ? "bg-emerald-950/70 text-emerald-200" : "bg-red-950/70 text-red-200"}`}
          >
            <p className="text-lg font-semibold">
              {report.valid
                ? "Verified: the record matches what was signed."
                : report.status === "completed"
                  ? "Does not verify."
                  : "Not complete yet."}
            </p>
            {report.problems.map((p) => (
              <p key={p} className="text-sm">
                {p}
              </p>
            ))}
            <p className="mt-1 text-xs opacity-80">Checked {when(report.checkedAt)}</p>
          </div>
          <ul className="space-y-1 text-sm">
            <Check ok={report.items.matches}>
              Item list fingerprint {short(report.items.storedHash)}
              {report.items.matches === false && ` (now ${short(report.items.currentHash)})`}
            </Check>
            {report.signatures.map((s) => (
              <Check key={s.id} ok={s.valid}>
                {partyLabel(s.party)} signature{s.signerName ? ` by ${s.signerName}` : ""}
                {s.valid ? "" : `: ${s.reason.replace(/_/g, " ")}`}
              </Check>
            ))}
            <Check ok={report.audit.entryId === null ? null : report.audit.found && report.audit.hashMatches && report.audit.contentMatches}>
              {report.audit.entryId === null ? (
                "Not in the audit log yet"
              ) : (
                <>
                  Audit-log entry <span className="font-mono">#{report.audit.entryId}</span>
                  {report.audit.occurredAt && `, ${when(report.audit.occurredAt)}`}
                </>
              )}
            </Check>
            <Check ok={report.receipt.attachmentId === null ? null : report.receipt.intact && report.receipt.matchesAudit}>
              {report.receipt.attachmentId === null ? "No stored receipt yet" : <>Stored PDF receipt sha256 {short(report.receipt.sha256)}</>}
            </Check>
          </ul>
          {report.changes && (report.changes.lines.length > 0 || report.changes.fields.length > 0) && (
            <div className="rounded-lg border border-red-900 p-3 text-sm">
              <p className="mb-1 font-medium text-red-200">Changed since it was signed</p>
              <ul className="space-y-0.5 text-slate-300">
                {report.changes.fields.map((f) => (
                  <li key={f}>Transfer detail: {f}</li>
                ))}
                {report.changes.lines.map((c) => (
                  <li key={c.key}>
                    {c.key === "order"
                      ? "The order of the lines"
                      : c.before && !c.after
                        ? `Removed: ${c.before.name} (${c.before.unitCode ?? c.before.assetCode})`
                        : !c.before && c.after
                          ? `Added: ${c.after.name} (${c.after.unitCode ?? c.after.assetCode})`
                          : `${c.after?.name ?? c.before?.name}: ${c.fields.join(", ")} changed` +
                            (c.fields.includes("outcome") ? ` (${c.before?.outcome} → ${c.after?.outcome})` : "")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Check a receipt PDF someone hands you against the records. */
export function ReceiptChecker() {
  const [result, setResult] = useState<{ found: boolean; report: VerifyReport | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await custodyApi.verifyReceipt(file));
    } catch (err) {
      setError(errorText(err, "The file could not be checked."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 text-sm">
      <label className={`${BTN_QUIET} inline-block cursor-pointer`}>
        {busy ? "Checking…" : "Check a receipt PDF"}
        <input type="file" accept="application/pdf" className="hidden" onChange={(e) => void check(e.target.files?.[0])} />
      </label>
      {error && <p className="text-red-300">{error}</p>}
      {result && !result.found && (
        <p className="rounded-lg bg-red-950/70 px-3 py-2 text-red-200">
          No receipt with these exact bytes was issued here. It may have been edited, or come from somewhere else.
        </p>
      )}
      {result?.report && (
        <p className={`rounded-lg px-3 py-2 ${result.report.valid ? "bg-emerald-950/70 text-emerald-200" : "bg-red-950/70 text-red-200"}`}>
          This is the receipt for{" "}
          <a className="underline" href={`/custody/transfers/${result.report.transferId}`}>
            {result.report.code}
          </a>
          . {result.report.valid ? "It verifies." : `It does not verify: ${result.report.problems.join(" ")}`}
        </p>
      )}
    </div>
  );
}
