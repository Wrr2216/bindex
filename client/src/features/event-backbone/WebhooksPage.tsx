import { useCallback, useEffect, useMemo, useState } from "react";
import { BUTTON, BUTTON_QUIET, FIELD, Field, Toggle } from "../../components/ui";
import { useTerms } from "../../config/useConfig";
import { webhooksApi } from "./api";
import { AdminOnly, DeliveryPill, PageHeader, RevealOnce, errorText, formatTime } from "./shared";
import type {
  DeliveryStatus,
  EventTypeInfo,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointInput,
} from "./types";

/** Settings → Webhooks: endpoints, the events they receive, and their delivery log. */
export function WebhooksPage() {
  return (
    <AdminOnly>
      <Webhooks />
    </AdminOnly>
  );
}

type Revealed = { label: string; value: string };

function Webhooks() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [catalog, setCatalog] = useState<EventTypeInfo[]>([]);
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      webhooksApi
        .list()
        .then(setEndpoints)
        .catch((err) => setError(errorText(err, "Could not load webhooks."))),
    [],
  );

  useEffect(() => {
    void load();
    webhooksApi.catalog().then(setCatalog).catch(() => setCatalog([]));
  }, [load]);

  const create = async (input: WebhookEndpointInput) => {
    const created = await webhooksApi.create(input);
    setRevealed({
      label: `Signing secret for ${created.url}. Copy it into the receiver now; it is not shown again.`,
      value: created.secret,
    });
    setAdding(false);
    await load();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhooks"
        description={
          <>
            Each event is POSTed as JSON to every endpoint whose events match, signed with the endpoint's secret in
            the <code className="text-slate-300">X-Bindex-Signature</code> header. Failed deliveries are retried after
            1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours; an endpoint that fails 50 times in a row is
            switched off and an alert is sent. The receiving side is described in docs/event-backbone.md.
          </>
        }
      />

      {revealed && <RevealOnce label={revealed.label} value={revealed.value} onDismiss={() => setRevealed(null)} />}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {endpoints?.map((ep) => (
        <EndpointCard key={ep.id} endpoint={ep} catalog={catalog} onChanged={load} onReveal={setRevealed} />
      ))}

      {endpoints && endpoints.length === 0 && !adding && (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
          No endpoints yet. Nothing leaves this server until you add one.
        </p>
      )}

      {adding ? (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold text-slate-100">New endpoint</h2>
          <EndpointForm catalog={catalog} submitLabel="Add endpoint" onSubmit={create} onCancel={() => setAdding(false)} />
        </section>
      ) : (
        <button onClick={() => setAdding(true)} className={BUTTON}>
          Add endpoint
        </button>
      )}
    </div>
  );
}

// ---- Form and pattern picker ------------------------------------------------------

function EndpointForm({
  initial,
  catalog,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: WebhookEndpoint;
  catalog: EventTypeInfo[];
  submitLabel: string;
  onSubmit: (input: WebhookEndpointInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [patterns, setPatterns] = useState<string[]>(initial?.eventPatterns ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ url: url.trim(), description: description.trim(), eventPatterns: patterns });
    } catch (err) {
      setError(errorText(err, "Could not save the endpoint."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="URL" hint="https:// recommended. Redirects are not followed.">
          <input
            className={FIELD}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://wms.example.com/hooks/bindex"
            inputMode="url"
          />
        </Field>
        <Field label="Description">
          <input
            className={FIELD}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Warehouse system"
            maxLength={200}
          />
        </Field>
      </div>
      <PatternPicker catalog={catalog} value={patterns} onChange={setPatterns} />
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={submit} disabled={busy || !url.trim() || patterns.length === 0} className={BUTTON}>
          {busy ? "Saving…" : submitLabel}
        </button>
        <button onClick={onCancel} className={BUTTON_QUIET}>
          Cancel
        </button>
        {patterns.length === 0 && <span className="text-sm text-slate-500">Choose at least one event.</span>}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}

type Group = { name: string; prefix: string; types: EventTypeInfo[] };

function PatternPicker({
  catalog,
  value,
  onChange,
}: {
  catalog: EventTypeInfo[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const terms = useTerms();
  const groups = useMemo(() => {
    const byPrefix = new Map<string, Group>();
    for (const t of catalog) {
      const prefix = t.type.split(".")[0]!;
      const group = byPrefix.get(prefix) ?? { name: t.group ?? prefix, prefix, types: [] };
      group.types.push(t);
      byPrefix.set(prefix, group);
    }
    return [...byPrefix.values()];
  }, [catalog]);

  const known = new Set(["*", ...groups.map((g) => `${g.prefix}.*`), ...catalog.map((t) => t.type)]);
  const custom = value.filter((p) => !known.has(p));
  const [customText, setCustomText] = useState(custom.join(", "));
  // The catalog can arrive after the form opens; until then every pattern
  // looks custom.
  useEffect(() => {
    setCustomText(value.filter((p) => !known.has(p)).join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  const has = (p: string) => value.includes(p);
  const toggle = (p: string, on: boolean) => onChange(on ? [...value.filter((v) => v !== p), p] : value.filter((v) => v !== p));
  const everything = has("*");

  const applyCustom = (text: string) => {
    setCustomText(text);
    const typed = text
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    onChange([...new Set([...value.filter((p) => known.has(p)), ...typed])]);
  };

  const groupLabel = (g: Group) => (g.prefix === "item" ? terms.item.plural : g.name);

  return (
    <fieldset className="space-y-3">
      <legend className="block text-xs font-medium uppercase tracking-wide text-slate-400">Events</legend>
      <label className="flex items-center gap-2 text-sm text-slate-200">
        <input type="checkbox" checked={everything} onChange={(e) => toggle("*", e.target.checked)} />
        Everything <code className="text-slate-500">*</code>
      </label>
      {!everything &&
        groups.map((g) => {
          const all = has(`${g.prefix}.*`);
          return (
            <div key={g.prefix} className="rounded-lg border border-slate-800 p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <input type="checkbox" checked={all} onChange={(e) => toggle(`${g.prefix}.*`, e.target.checked)} />
                All {groupLabel(g).toLowerCase()} events <code className="text-slate-500">{g.prefix}.*</code>
              </label>
              {!all && (
                <div className="mt-2 grid gap-1.5 pl-6 sm:grid-cols-2">
                  {g.types.map((t) => (
                    <label key={t.type} className="flex items-start gap-2 text-sm text-slate-300" title={t.description}>
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={has(t.type)}
                        onChange={(e) => toggle(t.type, e.target.checked)}
                      />
                      <span>
                        <code className="text-slate-200">{t.type}</code>
                        <span className="block text-xs text-slate-500">{t.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      {!everything && (
        <Field
          label="Other patterns"
          hint="Comma-separated, for types not listed yet. * matches anything, e.g. job.* or *.deleted"
        >
          <input className={FIELD} value={customText} onChange={(e) => applyCustom(e.target.value)} />
        </Field>
      )}
    </fieldset>
  );
}

// ---- One endpoint ---------------------------------------------------------------

function EndpointCard({
  endpoint: ep,
  catalog,
  onChanged,
  onReveal,
}: {
  endpoint: WebhookEndpoint;
  catalog: EventTypeInfo[];
  onChanged: () => Promise<unknown>;
  onReveal: (r: Revealed) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [logVersion, setLogVersion] = useState(0);

  const act = async (run: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const done = await run();
      if (done) setMessage(done);
      await onChanged();
      setLogVersion((v) => v + 1);
    } catch (err) {
      setMessage(errorText(err, "That did not work."));
    } finally {
      setBusy(false);
    }
  };

  const ping = () =>
    act(async () => {
      const d = await webhooksApi.ping(ep.id);
      return d.status === "succeeded"
        ? `Test delivered: HTTP ${d.responseStatus} in ${d.responseMs} ms.`
        : `Test failed: ${d.lastError ?? `HTTP ${d.responseStatus}`}`;
    });

  const setActive = (active: boolean) =>
    act(async () => {
      await webhooksApi.update(ep.id, { active });
      return active ? "Switched on. Waiting deliveries will go out." : "Switched off. Events are not queued while off.";
    });

  const rotate = () => {
    if (!window.confirm("Issue a new signing secret? The current one stops working immediately.")) return;
    void act(async () => {
      const { secret } = await webhooksApi.rotateSecret(ep.id);
      onReveal({ label: `New signing secret for ${ep.url}. Copy it now; it is not shown again.`, value: secret });
    });
  };

  const remove = () => {
    if (!window.confirm(`Delete the webhook to ${ep.url}? Its delivery log goes with it.`)) return;
    void act(() => webhooksApi.remove(ep.id));
  };

  if (editing) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-semibold text-slate-100">Edit endpoint</h2>
        <EndpointForm
          initial={ep}
          catalog={catalog}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            await webhooksApi.update(ep.id, input);
            setEditing(false);
            await onChanged();
          }}
        />
      </section>
    );
  }

  const { deliveries: d } = ep;
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-all font-semibold text-slate-100">{ep.description || ep.url}</h2>
          {ep.description && <p className="break-all text-sm text-slate-400">{ep.url}</p>}
          <p className="mt-1 text-xs text-slate-500">
            Secret <code>{ep.secretHint}</code> · added {formatTime(ep.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-400">{ep.active ? "On" : "Off"}</span>
          <Toggle checked={ep.active} onChange={(on) => void setActive(on)} label="Deliver to this endpoint" />
        </div>
      </div>

      {!ep.active && ep.disabledReason && (
        <p className="mt-3 rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          {ep.disabledReason}
          {ep.disabledAt ? ` (${formatTime(ep.disabledAt)})` : ""} Switch it back on once the receiver is fixed.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {ep.eventPatterns.map((p) => (
          <code key={p} className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
            {p}
          </code>
        ))}
      </div>

      <p className="mt-3 text-sm text-slate-400">
        {d.last
          ? `Last attempt ${formatTime(d.last.at)}: ${d.last.status === "succeeded" ? "delivered" : "failed"}${
              d.last.responseStatus ? ` (HTTP ${d.last.responseStatus})` : ""
            }.`
          : "Nothing sent yet."}
        {d.pending > 0 && ` ${d.pending} queued.`}
        {d.retrying > 0 && ` ${d.retrying} waiting to retry.`}
        {d.dead > 0 && ` ${d.dead} gave up.`}
        {ep.failureCount > 0 && ` ${ep.failureCount} failures in a row.`}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={() => void ping()} disabled={busy} className={BUTTON_QUIET}>
          Send test
        </button>
        <button onClick={() => setShowLog((v) => !v)} className={BUTTON_QUIET}>
          {showLog ? "Hide deliveries" : "Deliveries"}
        </button>
        <button onClick={() => setEditing(true)} className={BUTTON_QUIET}>
          Edit
        </button>
        <button onClick={rotate} disabled={busy} className={BUTTON_QUIET}>
          Rotate secret
        </button>
        <button
          onClick={remove}
          disabled={busy}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-red-400 hover:bg-slate-800 disabled:opacity-50"
        >
          Delete
        </button>
        {message && <span className="text-sm text-slate-400">{message}</span>}
      </div>

      {showLog && <DeliveryLog endpointId={ep.id} version={logVersion} onResent={() => void onChanged()} />}
    </section>
  );
}

// ---- Delivery log -----------------------------------------------------------------

function DeliveryLog({ endpointId, version, onResent }: { endpointId: string; version: number; onResent: () => void }) {
  const [status, setStatus] = useState<DeliveryStatus | "">("");
  const [rows, setRows] = useState<WebhookDelivery[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resending, setResending] = useState<number | null>(null);

  const load = useCallback(
    async (before: number | null) => {
      try {
        const page = await webhooksApi.deliveries(endpointId, { status, before });
        setRows((prev) => (before ? [...prev, ...page.deliveries] : page.deliveries));
        setNextBefore(page.nextBefore);
      } catch (err) {
        setMessage(errorText(err, "Could not load deliveries."));
      }
    },
    [endpointId, status],
  );

  useEffect(() => {
    void load(null);
  }, [load, version]);

  const resend = async (d: WebhookDelivery) => {
    setResending(d.id);
    setMessage(null);
    try {
      const again = await webhooksApi.redeliver(d.id);
      setMessage(
        again.status === "succeeded"
          ? `Event #${d.auditLogId} sent again: HTTP ${again.responseStatus}.`
          : `Sending again failed: ${again.lastError ?? `HTTP ${again.responseStatus}`}. It will be retried.`,
      );
      await load(null);
      onResent();
    } catch (err) {
      setMessage(errorText(err, "Could not send it again."));
    } finally {
      setResending(null);
    }
  };

  return (
    <div className="mt-4 border-t border-slate-800 pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200"
          value={status}
          onChange={(e) => setStatus(e.target.value as DeliveryStatus | "")}
          aria-label="Filter by status"
        >
          <option value="">All deliveries</option>
          <option value="succeeded">Delivered</option>
          <option value="failed">Failed</option>
          <option value="dead">Gave up</option>
          <option value="pending">Queued</option>
        </select>
        <button onClick={() => void load(null)} className="text-sm text-sky-400 hover:text-sky-300">
          Refresh
        </button>
        {message && <span className="text-sm text-slate-400">{message}</span>}
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400">
              <th className="py-2 pr-4 font-medium">When</th>
              <th className="py-2 pr-4 font-medium">Event</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Tries</th>
              <th className="py-2 pr-4 font-medium">Response</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-b border-slate-800/50 align-top">
                <td className="whitespace-nowrap py-2 pr-4 text-slate-400">{formatTime(d.updatedAt)}</td>
                <td className="py-2 pr-4">
                  <code className="text-slate-200">{d.eventType}</code>
                  {d.auditLogId !== null && <span className="text-slate-500"> #{d.auditLogId}</span>}
                </td>
                <td className="py-2 pr-4">
                  <DeliveryPill status={d.status} />
                  {d.status === "failed" && d.nextAttemptAt && (
                    <span className="mt-1 block text-xs text-slate-500">retry {formatTime(d.nextAttemptAt)}</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-slate-400">{d.attempts}</td>
                <td className="max-w-xs py-2 pr-4 text-slate-400">
                  {d.responseStatus !== null && <span>HTTP {d.responseStatus}</span>}
                  {d.responseMs !== null && <span className="text-slate-500"> · {d.responseMs} ms</span>}
                  {d.lastError && <span className="block break-words text-xs text-red-300/80">{d.lastError}</span>}
                </td>
                <td className="py-2 text-right">
                  {d.auditLogId !== null && d.status !== "pending" && (
                    <button
                      onClick={() => void resend(d)}
                      disabled={resending !== null}
                      className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                    >
                      {resending === d.id ? "Sending…" : "Resend"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-slate-500">
                  No deliveries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {nextBefore && (
        <button onClick={() => void load(nextBefore)} className="mt-3 text-sm text-sky-400 hover:text-sky-300">
          Older deliveries
        </button>
      )}
    </div>
  );
}
