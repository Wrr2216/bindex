import { useState } from "react";
import { SignDialog, type Signature } from "../media-ai-core";
import { inspectionsApi } from "./api";
import type { InspectionDetail, InspectionsMeta, SignRequest, SignoffRole, SignatureView } from "./types";
import { BTN, BTN_QUIET, CARD, H2, Notice, errorText, fmtDateTime } from "./ui";

/**
 * The two sign-offs: the facility contact and the crew lead, each on this
 * device. The content signed is built by the server from the record, and the
 * server checks the signature against it again before it counts, so a
 * signature made while someone else edited a finding is refused.
 */

const REASON: Record<string, string> = {
  content_changed: "Changed since signing",
  image_missing: "Signature image missing",
  image_altered: "Signature image altered",
};

export function SignoffsPanel({
  inspection,
  meta,
  onChanged,
}: {
  inspection: InspectionDetail;
  meta: InspectionsMeta;
  onChanged: () => void;
}) {
  const [signing, setSigning] = useState<SignRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = inspection.status === "draft";

  const start = async (role: SignoffRole) => {
    setError(null);
    try {
      setSigning(await inspectionsApi.signRequest(inspection.id, role));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const signed = async (signature: Signature) => {
    const role = signing!.role;
    setSigning(null);
    try {
      await inspectionsApi.recordSignoff(inspection.id, role, signature.id);
    } catch (err) {
      setError(errorText(err, "The signature could not be recorded. Sign again."));
    }
    onChanged();
  };

  const slot = (role: SignoffRole) => inspection.signatures.find((s) => s.role === role) ?? null;
  const others = inspection.signatures.filter((s) => !s.role);

  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className={H2}>Sign-off</h2>
      {draft && <Notice>Complete the inspection to collect signatures. Findings are locked while it is signed.</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        {meta.signoffs.map((r) => {
          const s = slot(r.value);
          return (
            <div key={r.value} className="space-y-2 rounded-lg border border-slate-800 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{r.label}</p>
              {s ? <SignatureCard s={s} /> : <p className="text-sm text-slate-500">Not signed yet.</p>}
              {!draft && (
                <button onClick={() => void start(r.value)} className={s ? BTN_QUIET : BTN}>
                  {s ? "Sign again" : `Sign as ${r.label.toLowerCase()}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {others.length > 0 && (
        <details className="text-sm text-slate-400">
          <summary className="cursor-pointer">Earlier signatures ({others.length})</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {others.map((s) => (
              <div key={s.id} className="rounded-lg border border-slate-800 p-2">
                <SignatureCard s={s} />
              </div>
            ))}
          </div>
        </details>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {signing && (
        <SignDialog
          ownerType={signing.ownerType}
          ownerId={signing.ownerId}
          statement={signing.statement}
          content={signing.content}
          title={`Sign as ${meta.signoffs.find((r) => r.value === signing.role)?.label.toLowerCase() ?? "signer"}`}
          defaultRole={meta.signoffs.find((r) => r.value === signing.role)?.label}
          onSigned={(s) => void signed(s)}
          onClose={() => setSigning(null)}
        />
      )}
    </section>
  );
}

function SignatureCard({ s }: { s: SignatureView }) {
  return (
    <div className="space-y-1">
      {s.imageUrl && <img src={s.imageUrl} alt={`Signature of ${s.signerName}`} className="h-16 rounded bg-white p-1" />}
      <p className="text-sm font-medium text-slate-100">{s.signerName}</p>
      <p className="text-xs text-slate-400">
        {[s.signerRole, s.signerEmail, fmtDateTime(s.signedAt)].filter(Boolean).join(" · ")}
      </p>
      <p className={`text-xs font-medium ${s.verification.valid ? "text-emerald-300" : "text-red-300"}`}>
        {s.verification.valid ? "Verified: matches the inspection as signed" : REASON[s.verification.reason] ?? "Does not verify"}
      </p>
    </div>
  );
}
