import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { AttachmentGallery, Modal } from "../media-ai-core";
import { portalAdminApi } from "./api";
import type {
  Grant,
  GrantActivity,
  GrantInput,
  GrantNote,
  GrantTarget,
  IssuedLink,
  PortalRole,
  PortalScopeKind,
  PortalStatus,
} from "./types";

/**
 * Portal: administrators make, change and revoke links for people outside,
 * and see what each link has been used for. Links are shown once, when made
 * or reissued; only their hashes are kept.
 */

const CARD = "rounded-xl border border-slate-800 bg-slate-900 p-4";
const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none";
const BTN = "rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
const BTN_QUIET = "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
const BTN_DANGER = "rounded-lg border border-red-900 px-3 py-2 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-50";
const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";

const errorText = (err: unknown, fallback = "Something went wrong.") =>
  err instanceof Error && err.message ? err.message : fallback;

const fmt = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";

const KIND_LABEL: Record<PortalScopeKind, string> = { project: "Project", job: "Job", shipment: "Shipment" };

function StateBadge({ grant }: { grant: Grant }) {
  const tone = {
    active: "bg-emerald-950 text-emerald-300",
    revoked: "bg-red-950 text-red-300",
    expired: "bg-slate-800 text-slate-400",
    no_link: "bg-amber-950 text-amber-300",
  }[grant.state];
  const label = { active: "Active", revoked: "Revoked", expired: "Expired", no_link: "No link" }[grant.state];
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${tone}`}>{label}</span>;
}

function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error" | "warn"; children: ReactNode }) {
  const cls = {
    info: "bg-slate-800/60 text-slate-300",
    ok: "bg-emerald-950/50 text-emerald-300",
    error: "bg-red-950/50 text-red-300",
    warn: "bg-amber-950/50 text-amber-300",
  }[tone];
  return <p className={`rounded-lg px-3 py-2 text-sm ${cls}`}>{children}</p>;
}

const dateInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** End of the chosen day, local time: a link "until the 30th" works all of the 30th. */
const endOfDay = (value: string) => new Date(`${value}T23:59:59`).toISOString();

export function PortalAdminPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<PortalStatus | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [state, setState] = useState<"active" | "inactive" | "">("active");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    portalAdminApi
      .list({ state: state || undefined, q: q.trim() || undefined })
      .then((g) => {
        setGrants(g);
        setError(null);
      })
      .catch((err) => {
        setGrants([]);
        setError(errorText(err, "Could not load portal links."));
      });
  }, [state, q]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    portalAdminApi.status().then(setStatus).catch(() => undefined);
  }, []);

  if (user?.role !== "admin") {
    return <p className={`${CARD} text-sm text-slate-400`}>Only an administrator can manage portal links.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">External portal</h1>
          <p className="text-sm text-slate-400">
            Links for customers, facilities managers and subcontracted crews to follow or work on one project, job or
            shipment, without an account.
          </p>
        </div>
        <button className={BTN} onClick={() => setCreating(true)}>
          New link
        </button>
      </div>

      {status?.trustedMode && (
        <Notice tone="warn">
          This server runs with AUTH_MODE=trusted, so anyone who can reach it is already its owner. Portal links only
          make sense behind real sign-in.
        </Notice>
      )}
      {status && !status.mailAvailable && (
        <Notice>
          Email is not set up (SMTP_URL), so links cannot ask for an emailed code, links cannot be emailed, and nobody
          gets milestone emails. Everything else works.
        </Notice>
      )}
      {issued && <LinkReveal issued={issued} onDismiss={() => setIssued(null)} />}
      {error && <Notice tone="error">{error}</Notice>}

      <section className={CARD}>
        <div className="flex flex-wrap gap-2">
          <select className={`${FIELD} w-40`} value={state} onChange={(e) => setState(e.target.value as typeof state)} aria-label="Show">
            <option value="active">Active</option>
            <option value="inactive">Revoked or expired</option>
            <option value="">All</option>
          </select>
          <input className={`${FIELD} flex-1`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by person, email or company" aria-label="Search" />
        </div>
        {grants === null ? (
          <p className="mt-3 text-sm text-slate-400">Loading…</p>
        ) : grants.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No links here yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-800">
            {grants.map((g) => (
              <li key={g.id}>
                <button type="button" onClick={() => setOpen(g.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-3 text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-100">
                      {g.granteeName}
                      {g.granteeOrg ? <span className="font-normal text-slate-400">, {g.granteeOrg}</span> : null}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {g.target ? `${KIND_LABEL[g.target.kind]} ${g.target.code} · ${g.target.name}` : "Record deleted"} ·{" "}
                      {g.role === "contributor" ? "Crew" : "Viewer"}
                    </span>
                  </span>
                  <span className="text-xs text-slate-500">
                    {g.lastUsedAt ? `Used ${fmt(g.lastUsedAt)}` : "Not used yet"} · until {fmt(g.expiresAt)}
                  </span>
                  <StateBadge grant={g} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {creating && status && (
        <NewLink
          status={status}
          onClose={() => setCreating(false)}
          onCreated={(i) => {
            setCreating(false);
            setIssued(i);
            load();
          }}
        />
      )}
      {open && status && (
        <GrantDetail
          id={open}
          status={status}
          onClose={() => setOpen(null)}
          onChanged={load}
          onIssued={(i) => {
            setIssued(i);
            setOpen(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function LinkReveal({ issued, onDismiss }: { issued: IssuedLink; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
    } catch {
      setError("Could not copy. Select the link and copy it by hand.");
    }
  };
  return (
    <div className="rounded-lg border border-amber-700 bg-amber-950/40 p-4" role="status">
      <p className="text-sm font-medium text-amber-300">
        Link for {issued.grant.granteeName}. Copy it now; it is not shown again.
        {issued.emailed ? " It has also been emailed to them." : ""}
      </p>
      <div className="mt-3 flex flex-wrap items-start gap-4">
        {issued.qr && <img src={issued.qr} alt="QR code of the link" className="h-32 w-32 rounded bg-white p-1" />}
        <div className="min-w-0 flex-1 space-y-2">
          <code className="block break-all rounded bg-slate-950 px-2 py-1 text-sm text-slate-200">{issued.url}</code>
          <div className="flex gap-2">
            <button className={BTN_QUIET} onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <button className="text-sm text-slate-400 hover:text-slate-200" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
          <p className="text-xs text-slate-400">Anyone with this link sees what it grants until it expires or you revoke it.</p>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function TargetPicker({ value, onChange }: { value: GrantTarget | null; onChange: (t: GrantTarget | null) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GrantTarget[]>([]);
  useEffect(() => {
    if (value) return;
    const t = setTimeout(() => {
      portalAdminApi.targets(q).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm">
        <span className="text-slate-100">
          {KIND_LABEL[value.kind]} {value.code} · {value.name}
          {value.jobCode ? <span className="text-slate-400"> (on {value.jobCode})</span> : null}
        </span>
        <button type="button" className="text-xs text-slate-400 hover:text-slate-200" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div>
      <input className={FIELD} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects, jobs and shipments by code or name" aria-label="What to share" autoFocus />
      <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-800">
        {results.map((r) => (
          <li key={`${r.kind}-${r.id}`}>
            <button type="button" className="flex w-full gap-2 px-3 py-2 text-left text-sm hover:bg-slate-800" onClick={() => onChange(r)}>
              <span className="w-20 shrink-0 text-xs uppercase text-slate-500">{KIND_LABEL[r.kind]}</span>
              <span className="text-slate-100">
                {r.code} · {r.name}
                {r.jobCode ? <span className="text-slate-400"> (on {r.jobCode})</span> : null}
              </span>
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Nothing matches.</li>}
      </ul>
    </div>
  );
}

type Draft = {
  role: PortalRole;
  granteeName: string;
  granteeOrg: string;
  granteeEmail: string;
  expires: string;
  showValues: boolean;
  showDocuments: boolean;
  requireCode: boolean;
  notify: boolean;
  stages: string[];
  note: string;
};

function Options({ draft, set, status, scope }: { draft: Draft; set: (p: Partial<Draft>) => void; status: PortalStatus; scope: PortalScopeKind | null }) {
  const terms = useTerms();
  const hasEmail = Boolean(draft.granteeEmail.trim());
  const crewAllowed = scope !== "project";
  return (
    <div className="space-y-3">
      <fieldset className="flex flex-wrap gap-4 text-sm text-slate-200">
        <legend className="mb-1 text-xs text-slate-400">They can</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={draft.role === "viewer"} onChange={() => set({ role: "viewer" })} />
          View progress, {terms.item.plural.toLowerCase()} and documents
        </label>
        <label className={`flex items-center gap-2 ${crewAllowed ? "" : "opacity-50"}`}>
          <input type="radio" checked={draft.role === "contributor"} disabled={!crewAllowed} onChange={() => set({ role: "contributor" })} />
          Work on it as a crew: scan, add notes and photos, sign
        </label>
      </fieldset>
      {!crewAllowed && <p className="text-xs text-slate-500">Crew links cover one job or one shipment.</p>}
      <div className="grid gap-2 sm:grid-cols-3">
        <input className={FIELD} value={draft.granteeName} onChange={(e) => set({ granteeName: e.target.value })} placeholder="Person or company" aria-label="Name" required maxLength={200} />
        <input className={FIELD} value={draft.granteeOrg} onChange={(e) => set({ granteeOrg: e.target.value })} placeholder="Organisation (optional)" aria-label="Organisation" maxLength={200} />
        <input className={FIELD} type="email" value={draft.granteeEmail} onChange={(e) => set({ granteeEmail: e.target.value })} placeholder="Email (optional)" aria-label="Email" maxLength={320} />
      </div>
      <label className="block text-sm text-slate-300">
        Works until
        <input
          className={`${FIELD} mt-1 w-48`}
          type="date"
          value={draft.expires}
          min={dateInput(new Date())}
          max={dateInput(new Date(Date.now() + (status.maxExpiryDays - 1) * 86_400_000))}
          onChange={(e) => set({ expires: e.target.value })}
          required
        />
      </label>
      <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.showDocuments} onChange={(e) => set({ showDocuments: e.target.checked })} />
          Share documents and signed receipts
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.showValues} onChange={(e) => set({ showValues: e.target.checked })} />
          Show values
        </label>
        <label className={`flex items-center gap-2 ${status.mailAvailable && hasEmail ? "" : "opacity-50"}`}>
          <input
            type="checkbox"
            checked={draft.requireCode}
            disabled={!status.mailAvailable || !hasEmail}
            onChange={(e) => set({ requireCode: e.target.checked })}
          />
          Ask for an emailed code on each new device
        </label>
        <label className={`flex items-center gap-2 ${hasEmail ? "" : "opacity-50"}`}>
          <input type="checkbox" checked={draft.notify} disabled={!hasEmail} onChange={(e) => set({ notify: e.target.checked })} />
          Email them milestones (they can switch this off)
        </label>
      </div>
      {draft.role === "contributor" && (
        <fieldset className="text-sm text-slate-200">
          <legend className="mb-1 text-xs text-slate-400">Stages the crew can scan to</legend>
          <div className="flex flex-wrap gap-3">
            {status.stages.map((s) => (
              <label key={s.name} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={draft.stages.includes(s.name)}
                  onChange={(e) =>
                    set({ stages: e.target.checked ? [...draft.stages, s.name] : draft.stages.filter((x) => x !== s.name) })
                  }
                />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <textarea className={FIELD} rows={2} value={draft.note} onChange={(e) => set({ note: e.target.value })} placeholder="Note for staff (never shown on the portal)" aria-label="Staff note" maxLength={2000} />
    </div>
  );
}

function payload(draft: Draft): Omit<GrantInput, "scope" | "targetId"> {
  return {
    role: draft.role,
    granteeName: draft.granteeName.trim(),
    granteeOrg: draft.granteeOrg.trim() || null,
    granteeEmail: draft.granteeEmail.trim() || null,
    expiresAt: endOfDay(draft.expires),
    showValues: draft.showValues,
    showDocuments: draft.showDocuments,
    requireCode: draft.requireCode && Boolean(draft.granteeEmail.trim()),
    notify: draft.notify && Boolean(draft.granteeEmail.trim()),
    allowedStages: draft.role === "contributor" ? draft.stages : null,
    note: draft.note.trim() || null,
  };
}

function NewLink({ status, onClose, onCreated }: { status: PortalStatus; onClose: () => void; onCreated: (i: IssuedLink) => void }) {
  const [target, setTarget] = useState<GrantTarget | null>(null);
  const [draft, setDraft] = useState<Draft>({
    role: "viewer",
    granteeName: "",
    granteeOrg: "",
    granteeEmail: "",
    expires: dateInput(new Date(Date.now() + status.defaultExpiryDays * 86_400_000)),
    showValues: false,
    showDocuments: true,
    requireCode: false,
    notify: false,
    stages: status.defaultStages,
    note: "",
  });
  const [sendEmail, setSendEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  useEffect(() => {
    if (target?.kind === "project" && draft.role === "contributor") set({ role: "viewer" });
  }, [target, draft.role]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await portalAdminApi.create({ scope: target.kind, targetId: target.id, ...payload(draft), sendEmail }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const canEmail = status.mailAvailable && Boolean(draft.granteeEmail.trim());
  return (
    <Modal title="New portal link" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <TargetPicker value={target} onChange={setTarget} />
        <Options draft={draft} set={set} status={status} scope={target?.kind ?? null} />
        <label className={`flex items-center gap-2 text-sm text-slate-200 ${canEmail ? "" : "opacity-50"}`}>
          <input type="checkbox" checked={sendEmail && canEmail} disabled={!canEmail} onChange={(e) => setSendEmail(e.target.checked)} />
          Email the link to them now
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_QUIET} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={BTN} disabled={busy || !target || !draft.granteeName.trim() || !draft.expires}>
            {busy ? "Making…" : "Make link"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const ACTIVITY_LABEL: Record<string, string> = {
  "portal.grant_created": "Link made",
  "portal.grant_updated": "Settings changed",
  "portal.grant_revoked": "Revoked",
  "portal.grant_reissued": "New link issued",
  "portal.accessed": "Opened",
  "portal.access_denied": "Refused",
  "portal.code_sent": "Code emailed",
  "portal.code_verified": "Code entered",
  "portal.code_failed": "Wrong code",
  "portal.scanned": "Scanned",
  "portal.note_added": "Note added",
  "portal.photo_added": "Photo added",
  "portal.handoff_signed": "Handoff signed",
  "portal.notify_changed": "Emails switched",
  "portal.notification_sent": "Milestone email sent",
};

function activityDetail(type: string, d: Record<string, unknown>): string {
  const parts: string[] = [];
  if (type === "portal.scanned") parts.push(`${String(d.advanced ?? 0)} to ${String(d.stage ?? "")}`);
  if (type === "portal.access_denied" && d.reason) parts.push(String(d.reason).replace(/_/g, " "));
  if (type === "portal.notify_changed") parts.push(d.enabled ? "on" : "off");
  if (type === "portal.notification_sent" && Array.isArray(d.milestones)) parts.push((d.milestones as string[]).join("; "));
  if (type === "portal.grant_updated" && Array.isArray(d.changed)) parts.push((d.changed as string[]).join(", "));
  if (d.ip) parts.push(String(d.ip));
  if (d.userAgent) parts.push(String(d.userAgent).slice(0, 60));
  return parts.join(" · ");
}

const draftFromGrant = (g: Grant, status: PortalStatus): Draft => ({
  role: g.role,
  granteeName: g.granteeName,
  granteeOrg: g.granteeOrg ?? "",
  granteeEmail: g.granteeEmail ?? "",
  expires: dateInput(new Date(g.expiresAt)),
  showValues: g.showValues,
  showDocuments: g.showDocuments,
  requireCode: g.requireCode,
  notify: g.notify,
  stages: g.allowedStages ?? status.defaultStages,
  note: g.note ?? "",
});

function GrantDetail({
  id,
  status,
  onClose,
  onChanged,
  onIssued,
}: {
  id: string;
  status: PortalStatus;
  onClose: () => void;
  onChanged: () => void;
  onIssued: (i: IssuedLink) => void;
}) {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activity, setActivity] = useState<GrantActivity | null>(null);
  const [notes, setNotes] = useState<GrantNote[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, a, n] = await Promise.all([portalAdminApi.get(id), portalAdminApi.activity(id), portalAdminApi.notes(id)]);
      setGrant(g);
      setDraft((d) => d ?? draftFromGrant(g, status));
      setActivity(a);
      setNotes(n);
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  }, [id, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: "ok", text: done });
      onChanged();
      await load();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!draft || !grant) return;
    const p = payload(draft);
    const expiresChanged = draft.expires !== dateInput(new Date(grant.expiresAt));
    void act(
      () => portalAdminApi.update(id, { ...p, expiresAt: expiresChanged ? p.expiresAt : undefined }),
      "Saved.",
    );
  };

  const revoke = () => {
    if (!window.confirm("Revoke this link? It stops working at once, for everyone who has it.")) return;
    void act(() => portalAdminApi.revoke(id), "Revoked.");
  };

  const reissue = async () => {
    if (!window.confirm("Issue a new link? The current one stops working at once.")) return;
    setBusy(true);
    try {
      onIssued(await portalAdminApi.reissue(id, Boolean(grant?.granteeEmail) && status.mailAvailable && window.confirm("Email the new link to them?")));
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const target = grant?.target;
  const live = grant && !grant.revokedAt;
  return (
    <Modal title={grant ? `${grant.granteeName}${grant.granteeOrg ? `, ${grant.granteeOrg}` : ""}` : "Portal link"} onClose={onClose} wide>
      {!grant || !draft ? (
        <p className="text-slate-400">{message?.text ?? "Loading…"}</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
            <StateBadge grant={grant} />
            <span>{target ? `${KIND_LABEL[target.kind]} ${target.code} · ${target.name}` : "The record this link was for is gone"}</span>
            <span className="text-slate-500">
              · made {fmt(grant.createdAt)} · {grant.useCount} requests
              {grant.lastUsedAt ? `, last ${fmt(grant.lastUsedAt)}` : ""}
              {grant.tokenLast4 ? ` · ends …${grant.tokenLast4}` : ""}
            </span>
          </div>
          {message && <Notice tone={message.tone}>{message.text}</Notice>}

          {live && (
            <form onSubmit={save} className="space-y-3">
              <Options draft={draft} set={(p) => setDraft((d) => (d ? { ...d, ...p } : d))} status={status} scope={grant.scope} />
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className={BTN_DANGER} disabled={busy} onClick={revoke}>
                  Revoke
                </button>
                <button type="button" className={BTN_QUIET} disabled={busy} onClick={() => void reissue()}>
                  {grant.hasLink ? "Issue a new link" : "Issue a link"}
                </button>
                <button type="submit" className={BTN} disabled={busy || !draft.granteeName.trim()}>
                  Save
                </button>
              </div>
            </form>
          )}

          {grant.showDocuments && target && (
            <section>
              <h3 className={H2}>Shared documents</h3>
              <p className="mb-2 text-xs text-slate-500">
                Files on this {KIND_LABEL[target.kind].toLowerCase()} are shared with the link
                {target.kind === "shipment" ? "" : ", along with those on its shipments"}.
              </p>
              <AttachmentGallery ownerType={target.kind} ownerId={target.id} kinds={["document", "photo"]} title="Documents" />
            </section>
          )}

          {notes.length > 0 && (
            <section>
              <h3 className={H2}>Crew notes</h3>
              <ul className="mt-2 space-y-2 text-sm">
                {notes.map((n) => (
                  <li key={n.id} className="rounded-lg bg-slate-800/50 p-2">
                    <p className="text-slate-200">
                      <span className="font-medium">{n.itemName}</span> <span className="text-xs text-slate-400">{n.unitCode ?? n.assetCode} · {n.jobCode}</span>
                    </p>
                    <p className="text-slate-300">
                      {n.condition ? `[${n.condition}] ` : ""}
                      {n.body}
                    </p>
                    <p className="text-xs text-slate-500">
                      {n.author} · {fmt(n.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className={H2}>Access log</h3>
            <p className="mb-2 text-xs text-slate-500">From the audit log: every visit, refusal and change made through this link.</p>
            <ul className="divide-y divide-slate-800 text-sm">
              {activity?.entries.map((e) => (
                <li key={e.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span className="text-slate-200">
                    {ACTIVITY_LABEL[e.type] ?? e.type}
                    <span className="ml-2 text-xs text-slate-500">{activityDetail(e.type, e.data)}</span>
                  </span>
                  <span className="text-xs text-slate-500">
                    {fmt(e.occurredAt)}
                    {e.actor.kind === "user" && e.actor.name ? ` · ${e.actor.name}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {activity?.nextBefore && (
              <button
                type="button"
                className={`${BTN_QUIET} mt-2`}
                onClick={() =>
                  void portalAdminApi.activity(id, activity.nextBefore!).then((more) =>
                    setActivity({ entries: [...activity.entries, ...more.entries], nextBefore: more.nextBefore }),
                  )
                }
              >
                Older
              </button>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
