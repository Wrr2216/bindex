import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { useFeatures } from "../../config/useConfig";
import { AttachmentGallery, Modal } from "../media-ai-core";
import { ActivityFeed } from "./Activity";
import { claimsApi, type ClaimPatch } from "./api";
import { EvidenceSummary, Timeline } from "./Evidence";
import { ClaimLines } from "./Lines";
import type { ClaimDetail as Detail, EvidencePack, Transition } from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  LABEL,
  MoneyInput,
  Notice,
  SELECT,
  SlaChip,
  StatusBadge,
  errorText,
  fmtDateTime,
  fromLocalInput,
  openDocument,
  toLocalInput,
  useCents,
  useClaimsMeta,
  useLocationOptions,
} from "./ui";

/** One claim or incident report: its workflow, lines, evidence and history. */
export function ClaimDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const features = useFeatures();
  const meta = useClaimsMeta();
  const [claim, setClaim] = useState<Detail | null>(null);
  const [evidence, setEvidence] = useState<EvidencePack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<Transition | null>(null);
  const [editing, setEditing] = useState(false);

  const loadEvidence = useCallback(() => {
    claimsApi.evidence(id).then(setEvidence).catch(() => setEvidence(null));
  }, [id]);

  const load = useCallback(async () => {
    try {
      setClaim(await claimsApi.get(id));
      setError(null);
    } catch (err) {
      setError(errorText(err, "The claim could not be loaded."));
    }
  }, [id]);

  useEffect(() => {
    void load();
    loadEvidence();
  }, [load, loadEvidence]);

  const changed = (next: Detail) => {
    const linesChanged = next.lines.length !== claim?.lines.length;
    setClaim(next);
    if (linesChanged) loadEvidence();
  };

  if (error && !claim) return <Notice tone="error">{error}</Notice>;
  if (!claim) return <p className="text-slate-400">Loading…</p>;

  const isMoney = claim.type !== "incident";
  const typeLabel = meta?.types.find((t) => t.type === claim.type)?.label ?? claim.type;
  const category = meta?.incidentCategories.find((c) => c.name === claim.category)?.label ?? claim.category;
  const related = typeof claim.metadata.relatedClaimId === "string" ? claim.metadata.relatedClaimId : null;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link to="/claims" className="text-sm text-slate-400 hover:text-slate-200">
          ← Claims and incidents
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-slate-400">{claim.code}</span>
          <h1 className="text-xl font-semibold text-slate-100">{claim.title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
            {typeLabel}
            {category ? `: ${category}` : ""}
          </span>
          <StatusBadge status={claim.status} />
          <SlaChip sla={claim.sla} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {claim.transitions.map((t) => {
          const blocked = t.decision && !claim.viewer.canDecide;
          return (
            <button
              key={t.to}
              onClick={() => setMoving(t)}
              disabled={blocked}
              title={blocked ? claim.viewer.decideRefusal ?? undefined : undefined}
              className={t.to === "denied" || (t.to === "closed" && claim.status === "draft") ? BTN_DANGER : t.decision || t.to === "submitted" ? BTN : BTN_QUIET}
            >
              {t.action}
            </button>
          );
        })}
        <span className="flex-1" />
        <button onClick={() => openDocument(claimsApi.pdfUrl(claim.id))} className={BTN_QUIET}>
          {isMoney ? "Adjuster PDF" : "PDF"}
        </button>
        <a href={claimsApi.xlsxUrl(claim.id)} className={BTN_QUIET}>
          Spreadsheet
        </a>
        {claim.type === "incident" && (
          <Link to={`/claims/new?from=${claim.id}`} className={BTN_QUIET}>
            Open a claim from this
          </Link>
        )}
        {claim.status === "draft" && (
          <button
            onClick={async () => {
              if (!confirm(`Delete draft ${claim.code}? This cannot be undone.`)) return;
              try {
                await claimsApi.remove(claim.id);
                navigate("/claims");
              } catch (err) {
                setError(errorText(err));
              }
            }}
            className={BTN_DANGER}
          >
            Delete draft
          </button>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {claim.status === "draft" && (
        <Notice>
          This is a draft. Add what it is about, then submit it: the evidence on file is fingerprinted and the decision deadline
          starts ({isMoney ? meta?.sla.claimHours : meta?.sla.incidentHours} hours).
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <section className={`${CARD} space-y-3 lg:col-span-2`}>
          <div className="flex items-center justify-between">
            <h2 className={H2}>Details</h2>
            {claim.status !== "closed" && (
              <button onClick={() => setEditing(!editing)} className="text-sm text-sky-300 hover:underline">
                {editing ? "Cancel" : "Edit"}
              </button>
            )}
          </div>
          {editing ? (
            <DetailsForm
              claim={claim}
              onSaved={(next) => {
                setClaim(next);
                setEditing(false);
              }}
            />
          ) : (
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              {claim.description && (
                <div className="sm:col-span-2">
                  <dt className={LABEL}>What happened</dt>
                  <dd className="whitespace-pre-wrap text-slate-200">{claim.description}</dd>
                </div>
              )}
              <Fact label="Job">
                {claim.jobId && features.jobs ? (
                  <Link to={`/jobs/${claim.jobId}`} className="text-sky-300 hover:underline">
                    {claim.jobCode} {claim.jobName}
                  </Link>
                ) : (
                  claim.jobCode ?? "None"
                )}
              </Fact>
              <Fact label="Shipment">
                {claim.shipmentId && features.jobs ? (
                  <Link to={`/shipments/${claim.shipmentId}`} className="text-sky-300 hover:underline">
                    {claim.shipmentCode} {claim.shipmentName}
                  </Link>
                ) : (
                  claim.shipmentCode ?? "None"
                )}
              </Fact>
              <Fact label="Occurred">{fmtDateTime(claim.occurredAt) || "Not given"}</Fact>
              <Fact label="Where">{claim.locationName ?? "Not given"}</Fact>
              <Fact label="Reported by">
                {claim.reporterName ?? "Unknown"}
                {claim.reporterGrantId ? " (portal)" : ""}
                {claim.reporterEmail ? ` · ${claim.reporterEmail}` : ""}
              </Fact>
              <Fact label="Opened">{fmtDateTime(claim.createdAt)}</Fact>
              {claim.submittedAt && <Fact label="Submitted">{fmtDateTime(claim.submittedAt)}</Fact>}
              {claim.sla.dueAt && <Fact label="Decision due">{fmtDateTime(claim.sla.dueAt)}</Fact>}
              {claim.decidedAt && <Fact label="Decided">{fmtDateTime(claim.decidedAt)}</Fact>}
              {claim.carrierReference && <Fact label="Carrier reference">{claim.carrierReference}</Fact>}
              {claim.insurerReference && <Fact label="Insurer reference">{claim.insurerReference}</Fact>}
              {claim.paymentReference && <Fact label="Payment reference">{claim.paymentReference}</Fact>}
              {related && (
                <Fact label="From incident">
                  <Link to={`/claims/${related}`} className="text-sky-300 hover:underline">
                    Open the incident report
                  </Link>
                </Fact>
              )}
            </dl>
          )}
        </section>

        <div className="space-y-5">
          {isMoney && <MoneyCard claim={claim} onChange={setClaim} />}
          <ReviewerCard claim={claim} onChange={setClaim} />
        </div>
      </div>

      <ClaimLines claim={claim} evidence={evidence} onChange={changed} />

      {evidence && (
        <section className={`${CARD} space-y-2`}>
          <h2 className={H2}>Evidence pack</h2>
          <EvidenceSummary pack={evidence} />
          {evidence.claim.signatures.length > 0 && (
            <ul className="space-y-1 text-sm text-slate-300">
              {evidence.claim.signatures.map((s) => (
                <li key={s.id}>
                  {s.signerName}
                  {s.signerRole ? ` (${s.signerRole})` : ""} signed the {s.ownerType} {fmtDateTime(s.signedAt)}: “{s.statement}”
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {features.aiCapture && (
        <section className={CARD}>
          <AttachmentGallery
            ownerType="claim"
            ownerId={claim.id}
            title="Files on the claim"
            stages={["damage", "estimate", "receipt"]}
            readOnly={claim.status === "closed"}
            onChange={() => loadEvidence()}
          />
        </section>
      )}

      {evidence && <Timeline entries={evidence.timeline} />}
      <ActivityFeed claim={claim} onComment={() => void load()} />

      {moving && (
        <TransitionDialog
          claim={claim}
          transition={moving}
          onClose={() => setMoving(null)}
          onDone={(next) => {
            setClaim(next);
            setMoving(null);
            loadEvidence();
          }}
        />
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className={LABEL}>{label}</dt>
      <dd className="text-slate-200">{children}</dd>
    </div>
  );
}

function MoneyCard({ claim, onChange }: { claim: Detail; onChange: (c: Detail) => void }) {
  const money = useCents(claim.currency);
  const [error, setError] = useState<string | null>(null);
  const open = ["draft", "submitted", "under_review"].includes(claim.status);
  const deciding = ["submitted", "under_review"].includes(claim.status) && claim.viewer.canDecide;
  const save = async (patch: ClaimPatch) => {
    setError(null);
    try {
      onChange(await claimsApi.update(claim.id, patch));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className={H2}>Amounts</h2>
      {claim.totals.fromLines ? (
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <Fact label="Claimed">{money(claim.totals.estimatedTotalCents)}</Fact>
          <Fact label="Approved">{money(claim.totals.approvedTotalCents)}</Fact>
          <Fact label="Paid">{money(claim.paidTotalCents)}</Fact>
        </dl>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className={LABEL}>Claimed</span>
            <MoneyInput value={claim.estimatedTotalCents} disabled={!open} label="Amount claimed" onCommit={(c) => void save({ estimatedTotalCents: c })} />
          </label>
          <label className="space-y-1">
            <span className={LABEL}>Approved</span>
            <MoneyInput value={claim.approvedTotalCents} disabled={!deciding} label="Amount approved" onCommit={(c) => void save({ approvedTotalCents: c })} />
          </label>
          {claim.paidTotalCents !== null && <Fact label="Paid">{money(claim.paidTotalCents)}</Fact>}
        </div>
      )}
      {claim.totals.fromLines && <p className="text-xs text-slate-500">The sums of the lines below.</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function ReviewerCard({ claim, onChange }: { claim: Detail; onChange: (c: Detail) => void }) {
  const { user } = useAuth();
  const [people, setPeople] = useState<{ userOid: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [due, setDue] = useState(toLocalInput(claim.slaDueAt));
  useEffect(() => setDue(toLocalInput(claim.slaDueAt)), [claim.slaDueAt]);
  const admin = user?.role === "admin";
  const mine = claim.assigneeUserOid !== null && claim.assigneeUserOid === user?.oid;

  useEffect(() => {
    if (admin) claimsApi.reviewers().then(setPeople).catch(() => setPeople([]));
  }, [admin]);

  const act = async (fn: () => Promise<Detail>) => {
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      setError(errorText(err));
    }
  };
  const closed = claim.status === "closed";
  const canMoveDue = ["submitted", "under_review"].includes(claim.status) && claim.viewer.canDecide;

  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className={H2}>Reviewer</h2>
      <p className="text-sm text-slate-200">{claim.assigneeName ?? "Nobody yet"}</p>
      {!closed && (
        <div className="flex flex-wrap gap-2">
          {admin && people ? (
            <select
              value={claim.assigneeUserOid ?? ""}
              onChange={(e) => void act(() => claimsApi.assign(claim.id, { userOid: e.target.value || null }))}
              aria-label="Reviewer"
              className={`${SELECT} w-full`}
            >
              <option value="">Nobody</option>
              {people.map((p) => (
                <option key={p.userOid} value={p.userOid}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : !claim.assigneeUserOid ? (
            <button onClick={() => void act(() => claimsApi.assign(claim.id, { me: true }))} className={BTN_QUIET}>
              Take it
            </button>
          ) : mine ? (
            <button onClick={() => void act(() => claimsApi.assign(claim.id, { userOid: null }))} className={BTN_QUIET}>
              Put it down
            </button>
          ) : null}
        </div>
      )}
      {canMoveDue && (
        <label className="block space-y-1">
          <span className={LABEL}>Decision due</span>
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            onBlur={() => {
              if (due && due !== toLocalInput(claim.slaDueAt)) void act(() => claimsApi.update(claim.id, { slaDueAt: fromLocalInput(due) }));
            }}
            className={FIELD}
          />
        </label>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function DetailsForm({ claim, onSaved }: { claim: Detail; onSaved: (c: Detail) => void }) {
  const meta = useClaimsMeta();
  const locations = useLocationOptions();
  const [f, setF] = useState({
    title: claim.title,
    description: claim.description ?? "",
    occurredAt: toLocalInput(claim.occurredAt),
    locationId: claim.locationId ?? "",
    category: claim.category ?? "",
    carrierReference: claim.carrierReference ?? "",
    insurerReference: claim.insurerReference ?? "",
    paymentReference: claim.paymentReference ?? "",
    reporterName: claim.reporterName ?? "",
    reporterEmail: claim.reporterEmail ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const isMoney = claim.type !== "incident";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const patch: ClaimPatch = {
        title: f.title,
        description: f.description || null,
        occurredAt: fromLocalInput(f.occurredAt),
        locationId: f.locationId || null,
        reporterName: f.reporterName || null,
        reporterEmail: f.reporterEmail || null,
      };
      if (!isMoney) patch.category = f.category || null;
      if (isMoney) {
        patch.carrierReference = f.carrierReference || null;
        patch.insurerReference = f.insurerReference || null;
        patch.paymentReference = f.paymentReference || null;
      }
      onSaved(await claimsApi.update(claim.id, patch));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block space-y-1">
        <span className={LABEL}>Title</span>
        <input value={f.title} onChange={set("title")} className={FIELD} required maxLength={200} />
      </label>
      <label className="block space-y-1">
        <span className={LABEL}>What happened</span>
        <textarea value={f.description} onChange={set("description")} rows={4} className={FIELD} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className={LABEL}>Occurred</span>
          <input type="datetime-local" value={f.occurredAt} onChange={set("occurredAt")} className={FIELD} />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Where</span>
          <select value={f.locationId} onChange={set("locationId")} className={`${SELECT} w-full`}>
            <option value="">Not given</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        {!isMoney && (
          <label className="space-y-1">
            <span className={LABEL}>Kind of incident</span>
            <select value={f.category} onChange={set("category")} className={`${SELECT} w-full`}>
              <option value="">Not given</option>
              {meta?.incidentCategories.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {isMoney && (
          <>
            <label className="space-y-1">
              <span className={LABEL}>Carrier reference</span>
              <input value={f.carrierReference} onChange={set("carrierReference")} className={FIELD} />
            </label>
            <label className="space-y-1">
              <span className={LABEL}>Insurer reference</span>
              <input value={f.insurerReference} onChange={set("insurerReference")} className={FIELD} />
            </label>
            <label className="space-y-1">
              <span className={LABEL}>Payment reference</span>
              <input value={f.paymentReference} onChange={set("paymentReference")} className={FIELD} />
            </label>
          </>
        )}
        <label className="space-y-1">
          <span className={LABEL}>Reported by</span>
          <input value={f.reporterName} onChange={set("reporterName")} className={FIELD} />
        </label>
        <label className="space-y-1">
          <span className={LABEL}>Their contact</span>
          <input value={f.reporterEmail} onChange={set("reporterEmail")} className={FIELD} />
        </label>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end">
        <button type="submit" disabled={saving} className={BTN}>
          Save
        </button>
      </div>
    </form>
  );
}

function TransitionDialog({
  claim,
  transition,
  onClose,
  onDone,
}: {
  claim: Detail;
  transition: Transition;
  onClose: () => void;
  onDone: (c: Detail) => void;
}) {
  const money = useCents(claim.currency);
  const [note, setNote] = useState("");
  const [paid, setPaid] = useState<number | null>(claim.totals.approvedTotalCents);
  const [reference, setReference] = useState(claim.paymentReference ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const required = transition.note === "required";

  const hint: Record<string, string> = {
    submitted: "Submitting fingerprints the evidence on file and starts the decision deadline.",
    under_review: claim.status === "submitted" ? "Tell the reporter it is being looked at." : "Reopening starts a fresh decision deadline.",
    approved:
      claim.totals.fromLines && claim.totals.undecidedLines > 0
        ? `Decide every line first: ${claim.totals.undecidedLines} still need a resolution and an approved amount.`
        : `Approves ${money(claim.totals.approvedTotalCents)}. Say what the decision rests on.`,
    denied: "Say why, in words the reporter can be given.",
    paid: "Record what was paid and how.",
    draft: "Send it back to the reporter. Say what is missing.",
    closed: claim.status === "paid" || claim.status === "denied" ? "Nothing more to do." : "Say why it is being closed.",
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (required && !note.trim()) {
      setError("A note is needed for this.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onDone(
        await claimsApi.setStatus(claim.id, {
          status: transition.to,
          note: note.trim() || null,
          ...(transition.to === "paid" ? { paidTotalCents: paid, paymentReference: reference.trim() || null } : {}),
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`${transition.action}: ${claim.code}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-300">{hint[transition.to]}</p>
        {transition.to === "paid" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className={LABEL}>Amount paid</span>
              <MoneyInput value={paid} onCommit={setPaid} label="Amount paid" />
            </label>
            <label className="space-y-1">
              <span className={LABEL}>Payment reference</span>
              <input value={reference} onChange={(e) => setReference(e.target.value)} className={FIELD} placeholder="Cheque or transfer number" />
            </label>
          </div>
        )}
        <label className="block space-y-1">
          <span className={LABEL}>Note{required ? "" : " (optional)"}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={FIELD} autoFocus required={required} />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={BTN_QUIET}>
            Cancel
          </button>
          <button type="submit" disabled={saving} className={transition.to === "denied" ? BTN_DANGER : BTN}>
            {transition.action}
          </button>
        </div>
      </form>
    </Modal>
  );
}
