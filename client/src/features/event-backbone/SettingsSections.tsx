import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BUTTON, BUTTON_QUIET, Pill, Section } from "../../components/ui";
import { auditLogApi, webhooksApi } from "./api";
import { errorText, formatTime, shortHash } from "./shared";
import type { AuditStatus, VerifyResult, WebhookEndpoint } from "./types";
import { VerifyResultView } from "./VerifyResultView";

/**
 * The two cards on the Settings screen. Each summarises its area and links to
 * the full page; neither renders anything until it has loaded.
 */
export function EventBackboneSettings() {
  return (
    <>
      <AuditLogCard />
      <WebhooksCard />
    </>
  );
}

function AuditLogCard() {
  const [status, setStatus] = useState<AuditStatus | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    auditLogApi.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  const verify = async () => {
    setVerifying(true);
    setError(null);
    try {
      setResult(await auditLogApi.verify());
    } catch (err) {
      setError(errorText(err, "Verification did not run."));
    } finally {
      setVerifying(false);
    }
  };

  if (!status) return null;
  return (
    <Section
      title="Audit log"
      description="Every change, scan and sync, in a hash-chained log that cannot be edited without it showing. Verify it, or export it as evidence that someone else can check without access to this server."
      aside={
        <span className="shrink-0 whitespace-nowrap">
          <Pill tone="on">{status.count.toLocaleString()} entries</Pill>
        </span>
      }
    >
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Latest entry</dt>
          <dd className="text-slate-300">
            {status.head ? (
              <>
                #{status.head.id} · {formatTime(status.head.occurredAt)} ·{" "}
                <code className="text-slate-400">{shortHash(status.head.hash)}</code>
              </>
            ) : (
              "Nothing recorded yet"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Last signed checkpoint</dt>
          <dd className="text-slate-300">
            {status.lastCheckpoint
              ? `#${status.lastCheckpoint.id} · ${formatTime(status.lastCheckpoint.occurredAt)}`
              : "None yet; one is written daily"}
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link to="/settings/audit-log" className={BUTTON}>
          Open audit log
        </Link>
        <button onClick={verify} disabled={verifying} className={BUTTON_QUIET}>
          {verifying ? "Verifying…" : "Verify chain"}
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
      {result && <VerifyResultView result={result} />}
    </Section>
  );
}

function WebhooksCard() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);

  useEffect(() => {
    webhooksApi.list().then(setEndpoints).catch(() => setEndpoints(null));
  }, []);

  if (!endpoints) return null;
  const off = endpoints.filter((e) => !e.active).length;
  const troubled = endpoints.filter((e) => e.active && (e.deliveries.retrying > 0 || e.deliveries.dead > 0)).length;

  return (
    <Section
      title="Webhooks"
      description="Send events to other systems as they happen: a warehouse, dispatch, CRM, claims or ERP system. Each delivery is signed and retried if the receiver is down."
      aside={
        <span className="shrink-0 whitespace-nowrap">
          <Pill tone={endpoints.length && !off ? "on" : "off"}>
            {endpoints.length === 0 ? "None" : `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`}
          </Pill>
        </span>
      }
    >
      {(off > 0 || troubled > 0) && (
        <p className="mt-3 text-sm text-amber-300">
          {off > 0 && `${off} switched off. `}
          {troubled > 0 && `${troubled} with failed deliveries.`}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link to="/settings/webhooks" className={endpoints.length ? BUTTON_QUIET : BUTTON}>
          {endpoints.length ? "Manage webhooks" : "Add a webhook"}
        </Link>
        <span className="text-sm text-slate-500">
          Systems that cannot receive webhooks can poll <code className="text-slate-400">GET /api/events</code> with
          an API key.
        </span>
      </div>
    </Section>
  );
}
