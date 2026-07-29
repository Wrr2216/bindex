import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/useAuth";
import { useConfig } from "../config/useConfig";
import { ApiKeysSection } from "../components/ApiKeysSection";
import { AccountsSection } from "../components/settings/AccountsSection";
import { InstanceSettings } from "../components/settings/InstanceSettings";
import { PasswordSection } from "../components/settings/PasswordSection";
import { BUTTON, BUTTON_QUIET, Pill, Section } from "../components/ui";
import type { NinjaStatus, RegistrarStatus, SyncRun } from "../types";

/** The NinjaOne connect flow returns here with a query parameter to report on. */
function readConnectResult(): string | null {
  const params = new URLSearchParams(window.location.search);
  const ninja = params.get("ninja");
  if (!ninja) return null;
  // Clear it so a refresh does not show the banner again.
  window.history.replaceState(null, "", window.location.pathname);
  if (ninja === "connected") return "NinjaOne connected.";
  if (ninja === "error") return "NinjaOne connection failed. Try again.";
  return null;
}

function LastRun({ run }: { run: SyncRun }) {
  return (
    <p className="mt-3 text-sm text-slate-400">
      Last run {new Date(run.startedAt).toLocaleString()}:{" "}
      {run.error ? (
        <span className="text-red-400">failed: {run.error}</span>
      ) : (
        <span>
          {run.created} created, {run.updated} updated
        </span>
      )}
    </p>
  );
}

function NinjaOneSection() {
  const [status, setStatus] = useState<NinjaStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(() => readConnectResult());

  const load = () => api.ninjaStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => {
    void load();
  }, []);

  const sync = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const r = await api.ninjaSync();
      setMessage(
        `Synced ${r.total} devices: ${r.created} created, ${r.updated} updated, ${r.pushed} asset IDs written back.`,
      );
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect NinjaOne? Sync stops until you reconnect.")) return;
    try {
      await api.ninjaDisconnect();
      setMessage("NinjaOne disconnected.");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Disconnect failed.");
    }
  };

  return (
    <Section
      title="NinjaOne sync"
      description="Pull managed devices and their asset IDs into the inventory."
      aside={
        <Pill tone={status?.connected ? "on" : "off"}>
          {!status?.enabled ? "Not configured" : status.connected ? "Connected" : "Not connected"}
        </Pill>
      }
    >
      {status?.lastRun && <LastRun run={status.lastRun} />}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {status?.enabled && !status.connected && (
          <a href="/api/ninjaone/connect" className={BUTTON}>
            Connect NinjaOne
          </a>
        )}
        {status?.connected && (
          <>
            <button onClick={sync} disabled={syncing} className={BUTTON}>
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button onClick={disconnect} className={BUTTON_QUIET}>
              Disconnect
            </button>
          </>
        )}
        {!status?.enabled && (
          <p className="text-sm text-slate-500">
            Set the <code className="text-slate-400">NINJAONE_*</code> environment variables to
            enable this.
          </p>
        )}
        {message && <span className="text-sm text-slate-400">{message}</span>}
      </div>
    </Section>
  );
}

function RegistrarSection() {
  const [status, setStatus] = useState<RegistrarStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => api.registrarStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => {
    void load();
  }, []);

  const sync = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const r = await api.registrarSync();
      setMessage(
        `Synced ${r.total} domains: ${r.created} created, ${r.updated} updated` +
          (r.flaggedMissing ? `, ${r.flaggedMissing} flagged missing.` : "."),
      );
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const providers = [status?.cloudflare && "Cloudflare", status?.porkbun && "Porkbun"]
    .filter(Boolean)
    .join(" + ");

  return (
    <Section
      title="Domain registrar sync"
      description={`Pull domains in as inventory, with expiry dates and auto-renew status. Domains expiring within ${status?.alertDays ?? 30} days with auto-renew off go into a daily digest, when notifications are configured.`}
      aside={<Pill tone={status?.enabled ? "on" : "off"}>{providers || "Not configured"}</Pill>}
    >
      {status?.lastRun && <LastRun run={status.lastRun} />}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {status?.enabled ? (
          <button onClick={sync} disabled={syncing} className={BUTTON}>
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        ) : (
          <p className="text-sm text-slate-500">
            Set <code className="text-slate-400">CLOUDFLARE_API_TOKEN</code>, or{" "}
            <code className="text-slate-400">PORKBUN_API_KEY</code> and{" "}
            <code className="text-slate-400">PORKBUN_SECRET_KEY</code>, to enable this.
          </p>
        )}
        {message && <span className="text-sm text-slate-400">{message}</span>}
      </div>
    </Section>
  );
}

function PrinterSection() {
  return (
    <Section
      title="Label printer"
      description="Labels are rendered as an exact-size PDF and printed from the browser to a printer attached to your own computer. Nothing is configured on the server."
    >
      <p className="mt-3 text-sm text-slate-400">
        Install the printer driver once per machine. In the print dialog, pick the printer, choose
        the roll or label stock you loaded, set margins to none and scale to 100 percent. Phones
        print the same way over AirPrint.
      </p>
      <p className="mt-2 text-sm text-slate-400">
        Label size is set by <code className="text-slate-400">LABEL_WIDTH_MM</code> and{" "}
        <code className="text-slate-400">LABEL_HEIGHT_MM</code>.
      </p>
      <div className="mt-4">
        <button
          onClick={() => window.open("/print?test=1", "_blank", "noopener")}
          className={BUTTON_QUIET}
        >
          Print a test label
        </button>
      </div>
    </Section>
  );
}

function BackupSection() {
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const restore = async (file: File) => {
    setMessage(null);
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(await file.text());
    } catch {
      setMessage("That file is not valid JSON.");
      return;
    }
    if (
      !window.confirm(
        "Restoring replaces all current data with the contents of this file. This cannot be undone. Continue?",
      )
    ) {
      return;
    }
    setRestoring(true);
    try {
      const r = await api.backupImport(snapshot);
      const total = Object.values(r.restored).reduce((a, b) => a + b, 0);
      setMessage(`Restored ${total} records.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Restore failed.");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Section
      title="Backup and restore"
      description="A full JSON snapshot: items, identifiers, images, locations and history. Secrets and caches are left out. Take one before anything risky."
    >
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <a href={api.backupExportUrl()} className={BUTTON}>
          Download backup
        </a>
        <label className={`${BUTTON_QUIET} cursor-pointer`}>
          {restoring ? "Restoring…" : "Restore from backup"}
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            disabled={restoring}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // allow picking the same file again
              if (file) void restore(file);
            }}
          />
        </label>
        {message && <span className="text-sm text-slate-400">{message}</span>}
      </div>
    </Section>
  );
}

export function Settings() {
  const { user, methods } = useAuth();
  const { config } = useConfig();
  const isAdmin = user?.role === "admin";
  // Only local accounts have a password to change; SSO and trusted-mode
  // identities are managed elsewhere.
  const canChangePassword = Boolean(methods?.password) && Boolean(user?.oid.startsWith("local:"));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">Settings</h1>

      {canChangePassword && <PasswordSection />}

      {!isAdmin ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
          Only an administrator can change how this instance is configured.
        </p>
      ) : (
        <>
          <InstanceSettings />
          <AccountsSection />
          {config.integrations.ninjaone && <NinjaOneSection />}
          {config.features.domains && <RegistrarSection />}
          <ApiKeysSection />
          {config.features.printing && <PrinterSection />}
          <BackupSection />
        </>
      )}
    </div>
  );
}
