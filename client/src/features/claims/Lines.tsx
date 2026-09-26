import { useEffect, useState } from "react";
import { useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import { claimsApi } from "./api";
import { ItemLink, LineEvidenceView } from "./Evidence";
import type { Candidate, ClaimDetail, ClaimLine, EvidencePack, LineProblem, Resolution } from "./types";
import { BTN_DANGER, BTN_QUIET, CARD, FIELD, H2, MoneyInput, Notice, SELECT, errorText, useCents, useClaimsMeta } from "./ui";

const EDITABLE = ["draft", "submitted", "under_review"];
const DECIDING = ["submitted", "under_review"];

/**
 * The claim's lines: what each is about, what it asks for and, for the
 * reviewer, what is decided. Each line opens onto its evidence.
 */
export function ClaimLines({
  claim,
  evidence,
  onChange,
}: {
  claim: ClaimDetail;
  evidence: EvidencePack | null;
  onChange: (claim: ClaimDetail) => void;
}) {
  const terms = useTerms();
  const money = useCents(claim.currency);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(claim.lines.slice(0, 1).map((l) => l.id)));
  const editable = EDITABLE.includes(claim.status);
  const isMoney = claim.type !== "incident";
  const deciding = isMoney && DECIDING.includes(claim.status) && claim.viewer.canDecide;

  const run = async (fn: () => Promise<ClaimDetail>) => {
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      setError(errorText(err));
    }
  };

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  return (
    <section className={`${CARD} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={H2}>{isMoney ? "Lines" : `${terms.item.plural} involved`}</h2>
        {isMoney && claim.totals.fromLines && (
          <span className="text-sm text-slate-300">
            {money(claim.totals.estimatedTotalCents)} claimed
            {claim.totals.approvedTotalCents !== null && ` · ${money(claim.totals.approvedTotalCents)} approved`}
            {claim.totals.undecidedLines > 0 && DECIDING.includes(claim.status) && (
              <span className="text-amber-300"> · {claim.totals.undecidedLines} to decide</span>
            )}
          </span>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {claim.lines.length === 0 && (
        <p className="text-sm text-slate-500">
          No lines. {editable ? `Add the ${terms.item.plural.toLowerCase()} it is about below, or scan them.` : ""}
        </p>
      )}
      <ul className="space-y-3">
        {claim.lines.map((line) => (
          <LineRow
            key={line.id}
            claim={claim}
            line={line}
            editable={editable}
            deciding={deciding}
            isMoney={isMoney}
            open={open.has(line.id)}
            onToggle={() => toggle(line.id)}
            evidence={evidence?.lines.find((e) => e.lineId === line.id) ?? null}
            run={run}
          />
        ))}
      </ul>
      {editable && <AddLines claim={claim} onChange={onChange} />}
    </section>
  );
}

function LineRow({
  claim,
  line,
  editable,
  deciding,
  isMoney,
  open,
  onToggle,
  evidence,
  run,
}: {
  claim: ClaimDetail;
  line: ClaimLine;
  editable: boolean;
  deciding: boolean;
  isMoney: boolean;
  open: boolean;
  onToggle: () => void;
  evidence: EvidencePack["lines"][number] | null;
  run: (fn: () => Promise<ClaimDetail>) => Promise<void>;
}) {
  const meta = useClaimsMeta();
  const money = useCents(claim.currency);
  const [damage, setDamage] = useState(line.damageDescription ?? "");
  useEffect(() => setDamage(line.damageDescription ?? ""), [line.damageDescription]);
  const update = (patch: Parameters<typeof claimsApi.updateLine>[2]) => run(() => claimsApi.updateLine(claim.id, line.id, patch));

  return (
    <li className="rounded-lg border border-slate-800">
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium text-slate-100">
              <ItemLink itemId={line.currentItemName !== null ? line.itemId : null}>{line.itemName ?? line.currentItemName ?? "Deleted item"}</ItemLink>
            </p>
            <p className="flex flex-wrap gap-x-2 text-xs text-slate-400">
              {line.assetCode && <span className="font-mono">{line.assetCode}</span>}
              {line.stageLabel && (
                <span className={line.stage && ["damaged", "missing", "refused", "wrong_shipment"].includes(line.stage) ? "text-red-300" : ""}>
                  {line.stageLabel}
                </span>
              )}
              {line.jobCode && <span>{line.jobCode}</span>}
              {line.shipmentCode && <span>{line.shipmentCode}</span>}
              <span>
                {line.photoCount} photo{line.photoCount === 1 ? "" : "s"}
              </span>
              {isMoney && line.declaredValueCents !== null && <span>declared {money(line.declaredValueCents)}</span>}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={onToggle} className={BTN_QUIET} aria-expanded={open}>
              {open ? "Hide evidence" : "Evidence"}
            </button>
            {editable && (
              <button
                onClick={() => {
                  if (confirm(`Take ${line.itemName ?? "this line"} off the claim?`)) void run(() => claimsApi.removeLine(claim.id, line.id));
                }}
                className={BTN_DANGER}
                aria-label={`Remove ${line.itemName ?? "line"}`}
              >
                Remove
              </button>
            )}
          </div>
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-slate-400">{isMoney ? "Damage or loss" : "What happened to it"}</span>
          <textarea
            value={damage}
            disabled={!editable}
            rows={2}
            onChange={(e) => setDamage(e.target.value)}
            onBlur={() => damage !== (line.damageDescription ?? "") && void update({ damageDescription: damage })}
            className={FIELD}
          />
        </label>

        {isMoney && (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Estimated</span>
              <MoneyInput
                value={line.estimatedCents}
                disabled={!editable}
                label={`Estimated for ${line.itemName ?? "line"}`}
                onCommit={(cents) => void update({ estimatedCents: cents })}
              />
              {editable && line.estimatedCents === null && line.declaredValueCents !== null && (
                <button onClick={() => void update({ estimatedCents: line.declaredValueCents })} className="text-xs text-sky-300 hover:underline">
                  Use the declared value
                </button>
              )}
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Resolution</span>
              <select
                value={line.resolution ?? ""}
                disabled={!deciding}
                onChange={(e) => void update({ resolution: (e.target.value || null) as Resolution | null })}
                className={`${SELECT} w-full`}
                title={deciding ? undefined : claim.viewer.decideRefusal ?? "Decided once the claim is submitted"}
              >
                <option value="">Not decided</option>
                {meta?.resolutions.map((r) => (
                  <option key={r.resolution} value={r.resolution}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Approved</span>
              <MoneyInput
                value={line.resolution === "deny" ? 0 : line.approvedCents}
                disabled={!deciding || line.resolution === "deny"}
                label={`Approved for ${line.itemName ?? "line"}`}
                onCommit={(cents) => void update({ approvedCents: cents })}
              />
            </label>
          </div>
        )}
      </div>
      {open && (
        <div className="border-t border-slate-800 bg-slate-950/40 p-3">
          {evidence ? <LineEvidenceView line={evidence} /> : <p className="text-sm text-slate-500">Gathering evidence…</p>}
        </div>
      )}
    </li>
  );
}

function AddLines({ claim, onChange }: { claim: ClaimDetail; onChange: (claim: ClaimDetail) => void }) {
  const terms = useTerms();
  const { armBulkCapture } = useScan();
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [problems, setProblems] = useState<LineProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [showJob, setShowJob] = useState(false);

  const add = async (lines: Parameters<typeof claimsApi.addLines>[1]) => {
    setError(null);
    try {
      const r = await claimsApi.addLines(claim.id, lines);
      setProblems(r.problems);
      onChange(r.claim);
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    if (!scanning) return;
    armBulkCapture((scanned) => void add([{ code: scanned }]));
    return () => armBulkCapture(null);
    // add closes over the claim id only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, armBulkCapture, claim.id]);

  useEffect(() => {
    if (!showJob || !claim.jobId) return;
    claimsApi.candidates(claim.jobId, claim.shipmentId).then(setCandidates).catch((err) => setError(errorText(err)));
  }, [showJob, claim.jobId, claim.shipmentId, claim.lines.length]);

  const onClaim = new Set(claim.lines.map((l) => l.jobItemId).filter(Boolean));

  return (
    <div className="space-y-2 border-t border-slate-800 pt-3">
      <div className="flex flex-wrap gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && code.trim()) {
              void add([{ code: code.trim() }]);
              setCode("");
            }
          }}
          placeholder={`Add ${terms.item.singular.toLowerCase()} by code`}
          aria-label="Code to add"
          className={`${FIELD} sm:w-64`}
        />
        <button
          onClick={() => {
            if (code.trim()) void add([{ code: code.trim() }]);
            setCode("");
          }}
          className={BTN_QUIET}
        >
          Add
        </button>
        <button onClick={() => setScanning(!scanning)} aria-pressed={scanning} className={BTN_QUIET}>
          {scanning ? "Stop scanning" : "Scan to add"}
        </button>
        {claim.jobId && (
          <button onClick={() => setShowJob(!showJob)} aria-pressed={showJob} className={BTN_QUIET}>
            From {claim.jobCode ?? "the job"}
          </button>
        )}
      </div>
      {scanning && <p className="text-xs text-sky-300">Scanning: every code read is added to the claim.</p>}
      {error && <Notice tone="error">{error}</Notice>}
      {problems.length > 0 && (
        <Notice tone="warn">
          {problems.map((p) => `${p.input ? `${p.input}: ` : ""}${p.problem}`).join(" ")}
        </Notice>
      )}
      {showJob && candidates && (
        <ul className="max-h-72 divide-y divide-slate-800 overflow-y-auto rounded-lg border border-slate-800">
          {candidates
            .filter((c) => !onClaim.has(c.jobItemId))
            .map((c) => (
              <li key={c.jobItemId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="text-slate-100">{c.itemName}</span>{" "}
                  <span className="font-mono text-xs text-slate-500">{c.assetCode}</span>{" "}
                  <span className={`text-xs ${c.flagged ? "text-red-300" : "text-slate-400"}`}>{c.stageLabel}</span>
                </span>
                <button onClick={() => void add([{ jobItemId: c.jobItemId }])} className={BTN_QUIET}>
                  Add
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
